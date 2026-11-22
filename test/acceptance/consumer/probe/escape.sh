#!/usr/bin/env bash
# Probe: what does the project's own CDK code hold while shukka synthesizes it? Runs inside the CDK
# app (bin/app.mjs) when infra/probe.on exists. Since shu-9zr the project's npm ci and cdk synth run
# only in infra.yml's synth job, which has no id-token permission; the credentialed jobs never run
# project code. So, on a merge to main and on a pull request alike, this code must find:
#   RESULT <p>-oidc NO-TOKEN          no OIDC token request URL or request token in the environment
#   RESULT <p>-aws NO-CREDS           no AWS credentials (environment, files, or a working identity)
#   RESULT <p>-github-token NO-TOKEN  no GitHub token in the environment or in the checkout's git config
# where <p> is R3-merge-synth (push to main), R4-pr-synth (pull request), R3-dispatch-synth (run by
# hand) or R2-<event>-synth. The opposite verdicts are TOKEN and CREDS; when it finds a token it also
# tries the roles with it (assume.sh), and with AWS credentials it tries the stand-in project and
# Trendigle (read only) as the older probe did, so a failure comes with what was reachable.
#
# Never prints a secret, only the names of the variables and files it found. Never fails the synth.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
t="$here/targets.json"
j() { jq -r "$1" "$t"; }
region=$(j .region)
export AWS_REGION=$region AWS_DEFAULT_REGION=$region AWS_PAGER=""

case "${GITHUB_EVENT_NAME:-}:${GITHUB_REF:-}" in
  pull_request:*) p=R4-pr-synth ;;
  push:refs/heads/main) p=R3-merge-synth ;;
  workflow_dispatch:refs/heads/main) p=R3-dispatch-synth ;;
  *) p="R2-${GITHUB_EVENT_NAME:-local}-synth" ;;
esac
echo "PROBE escape running in ${GITHUB_JOB:-?} of ${GITHUB_WORKFLOW_REF:-?} (${GITHUB_EVENT_NAME:-?} ${GITHUB_REF:-?})"

# attempt <id> <command...>: runs one AWS call and prints its verdict.
attempt() {
  local id=$1 err
  shift
  err=$(mktemp)
  if timeout 60 "$@" >/dev/null 2>"$err"; then
    echo "RESULT $id ALLOWED"
  elif grep -Eq 'AccessDenied|not authorized|UnauthorizedOperation|AuthorizationError|Forbidden|\(403\)' "$err"; then
    echo "RESULT $id DENIED $(tr '\n' ' ' <"$err" | cut -c1-160)"
  else
    echo "RESULT $id ERROR $(tr '\n' ' ' <"$err" | cut -c1-160)"
  fi
  rm -f "$err"
}

# Writes only to names that belong to this test (a guard against a mistake in targets.json).
writable() {
  [[ "$1" =~ ^(shukkatest|Shukkatest|standin-shukkatest|Standin-shukkatest) ]] ||
    { echo "RESULT escape-guard ERROR refusing to write to $1"; return 1; }
}

# What credentials found here could do to the stand-in project and Trendigle (read only).
other_projects() {
  local q=$1 st sb sq stk tt tb
  st=$(j .standin.table) sb=$(j .standin.bucket) stk=$(j .standin.stack) sq=$(j .standin.queue)
  tt=$(j .readOnly.trendigleTable) tb=$(j .readOnly.trendigleBucket)
  writable "$st" && attempt "$q-standin-table-write" aws dynamodb put-item --table-name "$st" \
    --item '{"pk":{"S":"shukkatest-probe"}}'
  writable "$sb" && attempt "$q-standin-bucket-write" aws s3api put-object --bucket "$sb" \
    --key shukkatest-probe.txt --body "$t"
  writable "$sq" && attempt "$q-standin-queue-create" aws sqs create-queue --queue-name "$sq"
  writable "$stk" && attempt "$q-standin-stack-update" aws cloudformation update-stack --stack-name "$stk" \
    --use-previous-template --tags Key=shukkatest-probe,Value=changed
  attempt "$q-trendigle-table-read" aws dynamodb describe-table --table-name "$tt" --query Table.TableStatus
  attempt "$q-trendigle-bucket-read" aws s3api list-objects-v2 --bucket "$tb" --max-keys 1 --query KeyCount
}

# 1. The GitHub OIDC token endpoint (what AssumeRoleWithWebIdentity needs).
oidc=()
[[ -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ]] && oidc+=(ACTIONS_ID_TOKEN_REQUEST_URL)
[[ -n "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" ]] && oidc+=(ACTIONS_ID_TOKEN_REQUEST_TOKEN)
if ((${#oidc[@]} == 0)); then
  echo "RESULT $p-oidc NO-TOKEN no OIDC token request URL or token in the environment"
else
  echo "RESULT $p-oidc TOKEN found ${oidc[*]}"
  bash "$here/assume.sh" "$p-oidc-assume" || true
fi

# 2. AWS credentials: variables, files, and whether any identity answers at all.
found=()
for v in AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_WEB_IDENTITY_TOKEN_FILE AWS_ROLE_ARN \
  AWS_CONTAINER_CREDENTIALS_FULL_URI AWS_CONTAINER_CREDENTIALS_RELATIVE_URI AWS_PROFILE; do
  [[ -n "${!v:-}" ]] && found+=("$v")
done
for f in "${AWS_SHARED_CREDENTIALS_FILE:-$HOME/.aws/credentials}" "${AWS_CONFIG_FILE:-$HOME/.aws/config}"; do
  [[ -s "$f" ]] && found+=("$f")
done
if me=$(timeout 60 aws sts get-caller-identity --query Arn --output text 2>/dev/null); then
  found+=("identity $me")
fi
if ((${#found[@]} == 0)); then
  echo "RESULT $p-aws NO-CREDS no AWS credential variables or files, and no identity answers"
else
  echo "RESULT $p-aws CREDS found ${found[*]}"
  [[ -n "${me:-}" ]] && other_projects "$p-held"
fi

# 3. A GitHub token: in the environment, or persisted by actions/checkout into the git config.
gh_found=()
for v in GITHUB_TOKEN GH_TOKEN; do
  [[ -n "${!v:-}" ]] && gh_found+=("$v")
done
if git -C "$here/.." config --get-regexp '^http\..*extraheader$' >/dev/null 2>&1; then
  gh_found+=("git http extraheader")
fi
if ((${#gh_found[@]} == 0)); then
  echo "RESULT $p-github-token NO-TOKEN no GitHub token in the environment or the checkout's git config"
else
  echo "RESULT $p-github-token TOKEN found ${gh_found[*]}"
fi
exit 0
