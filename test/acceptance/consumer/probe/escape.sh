#!/usr/bin/env bash
# Probe: what can the credentials in this process reach? Runs inside the CDK app (bin/app.mjs) when
# infra/probe.on exists, so it holds exactly what shukka's infra.yml hands the project's CDK code:
#   - on a merge to main: the infra role ("pipeline" credentials, R3)
#   - on a pull request:  the diff role (R4: a pull request's code must not get credentials that can
#                         change anything)
#
# Prints "RESULT <id> DENIED|ALLOWED|ERROR <detail>" lines for the acceptance suite. Writes are only
# ever attempted on shukkatest's own resources or the stand-in project (standin-shukkatest-*), both
# throwaway; Trendigle is only read (DescribeTable, a one-key listing). Never fails the synth.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
t="$here/targets.json"
j() { jq -r "$1" "$t"; }
account=$(j .account)
region=$(j .region)
qualifier=$(j .qualifier)
export AWS_REGION=$region AWS_DEFAULT_REGION=$region AWS_PAGER=""

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

# The same set of attempts against the stand-in project and Trendigle, with whatever credentials are
# in the environment now. $1 is the id prefix.
other_projects() {
  local p=$1 st sb sq stk tt tb
  st=$(j .standin.table) sb=$(j .standin.bucket) stk=$(j .standin.stack) sq=$(j .standin.queue)
  tt=$(j .readOnly.trendigleTable) tb=$(j .readOnly.trendigleBucket)
  writable "$st" && attempt "$p-standin-table-write" aws dynamodb put-item --table-name "$st" \
    --item '{"pk":{"S":"shukkatest-probe"}}'
  writable "$sb" && attempt "$p-standin-bucket-write" aws s3api put-object --bucket "$sb" \
    --key shukkatest-probe.txt --body "$t"
  writable "$sq" && attempt "$p-standin-queue-create" aws sqs create-queue --queue-name "$sq"
  writable "$stk" && attempt "$p-standin-stack-update" aws cloudformation update-stack --stack-name "$stk" \
    --use-previous-template --tags Key=shukkatest-probe,Value=changed
  writable "$stk" && attempt "$p-standin-stack-delete" aws cloudformation delete-stack --stack-name "$stk"
  # Trendigle: read-only attempts only.
  attempt "$p-trendigle-table-read" aws dynamodb describe-table --table-name "$tt" --query Table.TableStatus
  attempt "$p-trendigle-bucket-read" aws s3api list-objects-v2 --bucket "$tb" --max-keys 1 --query KeyCount
}

me=$(aws sts get-caller-identity --query Arn --output text 2>/dev/null) || {
  echo "RESULT escape-whoami ERROR no AWS credentials in the CDK app's environment"
  exit 0
}
echo "PROBE escape running as $me"

case "$me" in
  */shukkatest-shukka-infra/*)
    # Pipeline credentials (merge to main).
    other_projects R3-pipeline-infra
    attempt R3-pipeline-default-bootstrap-role aws sts assume-role \
      --role-arn "arn:aws:iam::$account:role/cdk-hnb659fds-deploy-role-$account-$region" \
      --role-session-name shukkatest-probe
    # The lookup roles carry account-wide read access; the infra role must reach neither (D10).
    attempt R3-pipeline-project-lookup-role aws sts assume-role \
      --role-arn "arn:aws:iam::$account:role/cdk-$qualifier-lookup-role-$account-$region" \
      --role-session-name shukkatest-probe
    attempt R3-pipeline-default-lookup-role aws sts assume-role \
      --role-arn "arn:aws:iam::$account:role/cdk-hnb659fds-lookup-role-$account-$region" \
      --role-session-name shukkatest-probe
    deploy_role="arn:aws:iam::$account:role/cdk-$qualifier-deploy-role-$account-$region"
    if creds=$(aws sts assume-role --role-arn "$deploy_role" --role-session-name shukkatest-probe \
      --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text 2>/dev/null); then
      # Control: the project's own deploy role must be reachable, or the pipeline could not deploy.
      echo "RESULT R3-pipeline-ctl-project-deploy-role ALLOWED"
      read -r ak sk tk <<<"$creds"
      (
        export AWS_ACCESS_KEY_ID=$ak AWS_SECRET_ACCESS_KEY=$sk AWS_SESSION_TOKEN=$tk
        other_projects R3-pipeline-deployrole
      )
    else
      echo "RESULT R3-pipeline-ctl-project-deploy-role DENIED could not assume $deploy_role"
    fi
    ;;
  */shukkatest-shukka-diff/*)
    # Pull-request credentials: must change nothing, not even shukkatest's own resources.
    attempt R4-prdiff-ctl-get-template aws cloudformation get-template --stack-name "$(j .own.stack)"
    attempt R4-prdiff-project-deploy-role aws sts assume-role \
      --role-arn "arn:aws:iam::$account:role/cdk-$qualifier-deploy-role-$account-$region" \
      --role-session-name shukkatest-probe
    attempt R4-prdiff-deploy-bucket-write aws s3api put-object --bucket "$(j .own.bucket)" \
      --key shukkatest/probe.txt --body "$t"
    attempt R4-prdiff-table-write aws dynamodb put-item --table-name "$(j .own.table)" \
      --item '{"pk":{"S":"shukkatest-probe"}}'
    attempt R4-prdiff-stack-update aws cloudformation update-stack --stack-name "$(j .own.stack)" \
      --use-previous-template --parameters ParameterKey=BootstrapVersion,UsePreviousValue=true \
      --tags Key=Project,Value=shukkatest Key=shukkatest-probe,Value=changed
    attempt R4-prdiff-send-command aws ssm send-command --document-name AWS-RunShellScript \
      --targets Key=tag:Project,Values=shukkatest --parameters 'commands=["true"]'
    other_projects R4-prdiff
    ;;
  *)
    echo "RESULT escape-whoami ERROR unexpected identity $me"
    ;;
esac
exit 0
