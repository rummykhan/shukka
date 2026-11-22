#!/usr/bin/env bash
# Probe: try to obtain each shukkatest deploy role from the job this runs in, the way an attacker's
# code in that job would (request a GitHub OIDC token, call sts:AssumeRoleWithWebIdentity). The roles
# are targets.json's .roles: shukka's infra, app and diff roles, and the CDK roles a token must never
# reach directly (the project's deploy and lookup roles, the default bootstrap's deploy and lookup).
#
#   assume.sh <prefix|auto>
#
# Prints one line per role, which the acceptance suite reads from the run log:
#   RESULT <prefix>-<role key> DENIED|ALLOWED|ERROR <detail>
#   CLAIMS <prefix> sub=... job_workflow_ref=... (claims only; the token itself is never printed)
# A job without `id-token: write` has no token endpoint at all; that is reported as DENIED.
# Never fails the job: the verdicts are the output.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
targets="$here/targets.json"
prefix=${1:-auto}
if [[ "$prefix" == auto ]]; then
  case "${GITHUB_EVENT_NAME:-}:${GITHUB_REF:-}" in
    pull_request:*) prefix=R2-pr ;;
    push:refs/heads/main | workflow_dispatch:refs/heads/main) prefix=R2-main-own-workflow ;;
    push:refs/heads/*) prefix=R2-branch ;;
    push:refs/tags/*) prefix=R2-tag ;;
    *) prefix="R2-${GITHUB_EVENT_NAME:-unknown}" ;;
  esac
fi
region=$(jq -r .region "$targets")
roles=()
while IFS= read -r r; do roles+=("$r"); done < <(jq -r '.roles | keys_unsorted[]' "$targets")

if [[ -z "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" || -z "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" ]]; then
  for r in "${roles[@]}"; do
    echo "RESULT $prefix-$r DENIED no OIDC token endpoint in this job (no id-token permission)"
  done
  exit 0
fi

token=$(curl -sS --max-time 20 -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
  "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=sts.amazonaws.com" | jq -r '.value // empty')
if [[ -z "$token" ]]; then
  for r in "${roles[@]}"; do echo "RESULT $prefix-$r ERROR the token endpoint returned no token"; done
  exit 0
fi
echo "::add-mask::$token"
payload=$(cut -d. -f2 <<<"$token" | tr '_-' '/+')
while (( ${#payload} % 4 )); do payload="$payload="; done
claims=$(base64 -d <<<"$payload" 2>/dev/null | jq -c '{sub, job_workflow_ref, ref, event_name, repository}' 2>/dev/null)
echo "CLAIMS $prefix $claims"

for r in "${roles[@]}"; do
  arn=$(jq -r --arg r "$r" '.roles[$r]' "$targets")
  err=$(mktemp)
  if env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN AWS_EC2_METADATA_DISABLED=true \
    aws sts assume-role-with-web-identity --region "$region" --role-arn "$arn" \
    --role-session-name "shukkatest-probe" --web-identity-token "$token" --duration-seconds 900 \
    --query 'AssumedRoleUser.Arn' --output text >/dev/null 2>"$err"; then
    echo "RESULT $prefix-$r ALLOWED assumed $arn"
  elif grep -q 'AccessDenied' "$err"; then
    echo "RESULT $prefix-$r DENIED $(tr '\n' ' ' <"$err" | cut -c1-200)"
  else
    echo "RESULT $prefix-$r ERROR $(tr '\n' ' ' <"$err" | cut -c1-200)"
  fi
  rm -f "$err"
done
exit 0
