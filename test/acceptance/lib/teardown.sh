# shellcheck shell=bash
# Teardown: removes every throwaway resource, found by name and tag (not only from this run's state),
# so it also cleans up after a run that crashed. Every delete goes through require_ours().
# Order matters: project stacks first (CloudFormation deletes them with the project's execution role,
# which the bootstrap stack owns), then retained data, then the bootstrap, then the boundary.
# If project stacks cannot be deleted, the bootstrap is left in place (deleting it would orphan them)
# and reported.

# ---------------------------------------------------------------------------------------------
# Discovery (read-only)

# our_stacks: live stacks whose names mark them as shukkatest's or the stand-in's, and shukka
# bootstrap's two stacks for shukkatest, by their exact names (never CDKToolkit or another project's).
our_stacks() {
  local all
  all=$(aws cloudformation list-stacks --query "StackSummaries[?StackStatus!='DELETE_COMPLETE'].StackName" \
    --output text 2>/dev/null | text_items)
  {
    grep -Ei '^(shukkatest|standin-shukkatest)' <<<"$all"
    grep -Fx -e "$BOOTSTRAP_STACK" -e "$BOUNDARY_STACK" <<<"$all"
  } || true
}

# is_boundary_stack <stack>: it holds the shukkatest-shukka-* managed policies.
is_boundary_stack() {
  aws cloudformation describe-stack-resources --stack-name "$1" \
    --query "StackResources[?ResourceType=='AWS::IAM::ManagedPolicy'].PhysicalResourceId" --output text 2>/dev/null |
    text_items | grep -q "$PROJECT-shukka-"
}

project_stacks() {
  local s q
  q=$(qualifier_stacks)
  for s in $(our_stacks); do
    [[ "$s" =~ ^[Ss]tandin- ]] && continue
    [[ "$s" == "$BOUNDARY_STACK" ]] && continue
    grep -qx -- "$s" <<<"$q" && continue
    is_boundary_stack "$s" && continue
    printf '%s\n' "$s"
  done
}

# boundary_stacks: Shukka-Boundary-shukkatest by name (found even when DELETE_FAILED has left it without
# its policies), and any other shukkatest-named stack that holds the shukkatest-shukka-* policies.
boundary_stacks() {
  local s q
  q=$(qualifier_stacks)
  for s in $(our_stacks); do
    grep -qx -- "$s" <<<"$q" && continue
    if [[ "$s" == "$BOUNDARY_STACK" ]] || is_boundary_stack "$s"; then printf '%s\n' "$s"; fi
  done | sort -u
}

# leftovers: one line per throwaway resource that still exists. Empty means clean.
leftovers() {
  local acct x arn state
  acct=$(aws sts get-caller-identity --query Account --output text 2>/dev/null)
  for x in $(our_stacks) $(qualifier_stacks); do printf 'LEFTOVER stack %s\n' "$x"; done | sort -u
  for x in $(aws s3api list-buckets --query 'Buckets[].Name' --output text 2>/dev/null | text_items |
    grep -E '^(shukkatest-|cdk-shukkatest-|standin-shukkatest-)' || true); do printf 'LEFTOVER bucket %s\n' "$x"; done
  for x in $(aws dynamodb list-tables --query 'TableNames[]' --output text 2>/dev/null | text_items |
    grep -E '^(shukkatest|standin-shukkatest)' || true); do printf 'LEFTOVER table %s\n' "$x"; done
  for x in $(aws iam list-roles --query 'Roles[].RoleName' --output text 2>/dev/null | text_items |
    grep -E '^(shukkatest|Shukkatest|cdk-shukkatest-|standin-shukkatest)' || true); do printf 'LEFTOVER role %s\n' "$x"; done
  for x in $(aws iam list-policies --scope Local --query 'Policies[].PolicyName' --output text 2>/dev/null | text_items |
    grep -E '^(shukkatest|Shukkatest)' || true); do printf 'LEFTOVER policy %s\n' "$x"; done
  for x in $(aws route53 list-hosted-zones --query 'HostedZones[].[Id,Name]' --output text 2>/dev/null |
    awk '$2 ~ /^shukkatest-/ {sub("/hostedzone/", "", $1); print $1 ":" $2}'); do printf 'LEFTOVER zone %s\n' "$x"; done
  for x in $(aws ssm get-parameters-by-path --path "/$PROJECT" --recursive --query 'Parameters[].Name' --output text 2>/dev/null | text_items); do
    printf 'LEFTOVER parameter %s\n' "$x"
  done
  for x in $(aws ecr describe-repositories --query 'repositories[].repositoryName' --output text 2>/dev/null | text_items |
    grep -E '^cdk-shukkatest-' || true); do printf 'LEFTOVER ecr %s\n' "$x"; done
  # Anything still tagged as ours. Terminated instances keep their tags for up to an hour; they are
  # gone for all purposes, so they are not counted.
  # The tagging API also lists resources deleted a while ago (ENIs, volumes), so each ARN is described
  # first and only reported if it is still there.
  for arn in $(aws resourcegroupstaggingapi get-resources --tag-filters "Key=Project,Values=$PROJECT,shukkatest-standin" \
    --query 'ResourceTagMappingList[].ResourceARN' --output text 2>/dev/null | text_items); do
    if [[ "$arn" == *:instance/* ]]; then
      state=$(aws ec2 describe-instances --instance-ids "${arn##*/}" --query 'Reservations[0].Instances[0].State.Name' --output text 2>/dev/null || echo gone)
      [[ "$state" == terminated || "$state" == gone || "$state" == None ]] && continue
    elif ! arn_exists "$arn"; then
      continue
    fi
    printf 'LEFTOVER tagged %s\n' "${arn//$acct/123456789012}"
  done
}

# aws_not_found <aws args...>: runs the read-only call; true only if it failed because the thing is not
# there. Success, or any other error (a denied read, a throttle), counts as present.
aws_not_found() {
  local err
  if err=$(aws "$@" 2>&1 >/dev/null); then return 1; fi
  grep -Eiq 'NotFound|does not exist|NoSuch|Not Found|\(404\)|NonExistent' <<<"$err"
}

# arn_exists <arn>: false only when a describe of that resource says it is gone. Kinds this does not
# know how to describe are taken to exist (reported, never hidden).
arn_exists() {
  local arn=$1 svc res id st
  svc=$(cut -d: -f3 <<<"$arn")
  res=$(cut -d: -f6- <<<"$arn")
  id=${res##*/}
  case "$svc:$res" in
    ec2:volume/*) ! aws_not_found ec2 describe-volumes --volume-ids "$id" ;;
    ec2:network-interface/*) ! aws_not_found ec2 describe-network-interfaces --network-interface-ids "$id" ;;
    ec2:security-group/*) ! aws_not_found ec2 describe-security-groups --group-ids "$id" ;;
    ec2:launch-template/*) ! aws_not_found ec2 describe-launch-templates --launch-template-ids "$id" ;;
    ec2:snapshot/*) ! aws_not_found ec2 describe-snapshots --snapshot-ids "$id" ;;
    ec2:image/*) ! aws_not_found ec2 describe-images --image-ids "$id" ;;
    cloudformation:stack/*)
      # describe-stacks by ARN still answers for a deleted stack, with DELETE_COMPLETE.
      st=$(stack_status "$arn")
      [[ "$st" != ABSENT && "$st" != DELETE_COMPLETE ]] ;;
    s3:*) ! aws_not_found s3api head-bucket --bucket "$res" ;;
    dynamodb:table/*) ! aws_not_found dynamodb describe-table --table-name "$id" ;;
    sqs:*) ! aws_not_found sqs get-queue-url --queue-name "$res" ;;
    iam:role/*) ! aws_not_found iam get-role --role-name "$id" ;;
    route53:hostedzone/*) ! aws_not_found route53 get-hosted-zone --id "$id" ;;
    ssm:parameter/*) ! aws_not_found ssm get-parameter --name "/${res#parameter/}" ;;
    logs:log-group:*)
      id=${res#log-group:}
      id=${id%:\*}
      [[ -n "$(aws logs describe-log-groups --log-group-name-prefix "$id" \
        --query "logGroups[?logGroupName=='$id'].logGroupName" --output text 2>/dev/null | text_items)" ]] ;;
    *) return 0 ;;
  esac
}
no_leftovers() { [[ -z "$(leftovers)" ]]; }

# ---------------------------------------------------------------------------------------------
# Deleting

# empty_bucket <name>: deletes every object version and delete marker.
empty_bucket() {
  local b=$1 batch
  require_ours "$b"
  aws s3api head-bucket --bucket "$b" >/dev/null 2>&1 || return 0
  while :; do
    batch=$(aws s3api list-object-versions --bucket "$b" --max-items 500 --output json \
      --query '{Objects: [Versions, DeleteMarkers][][].{Key: Key, VersionId: VersionId}}' 2>/dev/null)
    if [[ -z "$batch" ]] || [[ "$(jq '.Objects | length' <<<"$batch")" == 0 ]]; then break; fi
    aws s3api delete-objects --bucket "$b" --delete "$(jq -c '{Objects: .Objects, Quiet: true}' <<<"$batch")" >/dev/null || return 1
  done
}

delete_bucket() {
  require_ours "$1"
  aws s3api head-bucket --bucket "$1" >/dev/null 2>&1 || return 0
  log "teardown: bucket $1"
  empty_bucket "$1" && aws s3api delete-bucket --bucket "$1"
}

delete_table() {
  require_ours "$1"
  log "teardown: table $1"
  aws dynamodb delete-table --table-name "$1" >/dev/null 2>&1 || true
  aws dynamodb wait table-not-exists --table-name "$1" 2>/dev/null
}

# stack_settled <name>: the stack is absent, in a terminal state (nothing in progress), or in
# REVIEW_IN_PROGRESS: a stack created by a change set that was never executed. It has no resources,
# nothing will move it on by itself, and delete-stack works on it, so it is deleted at once.
stack_settled() {
  local st
  st=$(stack_status "$1")
  [[ "$st" == REVIEW_IN_PROGRESS || "$st" != *_IN_PROGRESS ]]
}

# delete_failed_resources <stack>: logical ids of the stack's resources in DELETE_FAILED.
delete_failed_resources() {
  aws cloudformation describe-stack-resources --stack-name "$1" \
    --query "StackResources[?ResourceStatus=='DELETE_FAILED'].LogicalResourceId" --output text 2>/dev/null | text_items
}

# delete_stack <name>: waits for any operation in progress (a deploy that was running when teardown
# began) to finish, then deletes, retrying while the stack is still there. When a delete leaves the
# stack DELETE_FAILED, it retries once at once with --retain-resources for the resources that failed
# (a resource whose creation was cancelled, so nothing exists, but which the execution role may not
# delete): the stack goes, and anything real it kept is still found by leftovers. Non-zero if it remains.
delete_stack() {
  local s=$1 attempt st retained=0 failed
  if ! is_ours "$s" && ! grep -qx -- "$s" <<<"$(qualifier_stacks)"; then
    die "refusing to delete stack '$s'"
  fi
  for attempt in 1 2 3 4; do
    if ! wait_until 3600 20 stack_settled "$s"; then
      log "teardown: stack $s is still $(stack_status "$s") after an hour"
      return 1
    fi
    st=$(stack_status "$s")
    [[ "$st" == ABSENT || "$st" == DELETE_COMPLETE ]] && return 0
    log "teardown: stack $s ($st), delete attempt $attempt"
    aws cloudformation delete-stack --stack-name "$s" || { sleep 30; continue; }
    wait_until 3600 20 stack_settled "$s" || true
    st=$(stack_status "$s")
    [[ "$st" == ABSENT || "$st" == DELETE_COMPLETE ]] && return 0
    log "teardown: stack $s is $st"
    aws cloudformation describe-stack-events --stack-name "$s" --max-items 10 \
      --query "StackEvents[?contains(ResourceStatus, 'FAILED')].[LogicalResourceId, ResourceStatusReason]" --output text >&2 || true
    if [[ "$st" == DELETE_FAILED && $retained == 0 ]]; then
      retained=1
      failed=$(delete_failed_resources "$s")
      if [[ -n "$failed" ]]; then
        log "teardown: stack $s, deleting again and retaining $(paste -sd ' ' - <<<"$failed")"
        # shellcheck disable=SC2086 # one argument per logical id
        if aws cloudformation delete-stack --stack-name "$s" --retain-resources $failed; then
          wait_until 3600 20 stack_settled "$s" || true
          st=$(stack_status "$s")
          [[ "$st" == ABSENT || "$st" == DELETE_COMPLETE ]] && return 0
          log "teardown: stack $s is $st after retaining its failed resources"
        fi
      fi
    fi
    sleep 30
  done
  return 1
}

# active_runs: ids of runs in the test consumer that are not finished.
active_runs() {
  local s
  for s in queued in_progress waiting pending requested; do
    gh run list -R "$CONSUMER_REPO" --status "$s" --limit 100 --json databaseId -q '.[].databaseId' 2>/dev/null
  done | sort -u
}
no_active_runs() { [[ -z "$(active_runs)" ]]; }

# td_github: stop the test consumer from deploying anything while (and after) resources are deleted:
# disable every workflow there, cancel what is queued or running and wait until it has all finished.
# The caller stays disabled; the next run's setup enables it before its first merge.
td_github() {
  local w id rc=0
  for w in $(gh workflow list -R "$CONSUMER_REPO" --all --json id,state -q '.[] | select(.state == "active") | .id' 2>/dev/null); do
    gh workflow disable "$w" -R "$CONSUMER_REPO" >/dev/null 2>&1 || rc=1
  done
  for id in $(active_runs); do
    gh run cancel "$id" -R "$CONSUMER_REPO" >/dev/null 2>&1 || true
  done
  if ! wait_until 1800 15 no_active_runs; then
    log "teardown: runs still active in $CONSUMER_REPO: $(active_runs | tr '\n' ' ')"
    rc=1
  fi
  clean_consumer_github
  gh variable delete SHUKKATEST_GREETING -R "$CONSUMER_REPO" >/dev/null 2>&1 || true
  return $rc
}

td_project_stacks() {
  local s rc=0 acct
  acct=$(aws sts get-caller-identity --query Account --output text)
  empty_bucket "shukkatest-deploy-$acct" || true
  for s in $(project_stacks); do delete_stack "$s" || rc=1; done
  return $rc
}

td_retained_data() {
  local x
  for x in $(aws dynamodb list-tables --query 'TableNames[]' --output text 2>/dev/null | text_items | grep -E '^shukkatest' || true); do
    delete_table "$x"
  done
  for x in $(aws s3api list-buckets --query 'Buckets[].Name' --output text 2>/dev/null | text_items | grep -E '^shukkatest-' || true); do
    delete_bucket "$x" || true
  done
}

td_bootstrap() {
  local s bucket repo rc=0 p arn v
  for s in $(qualifier_stacks); do
    bucket=$(aws cloudformation describe-stack-resources --stack-name "$s" \
      --query "StackResources[?ResourceType=='AWS::S3::Bucket'].PhysicalResourceId | [0]" --output text 2>/dev/null)
    repo=$(aws cloudformation describe-stack-resources --stack-name "$s" \
      --query "StackResources[?ResourceType=='AWS::ECR::Repository'].PhysicalResourceId | [0]" --output text 2>/dev/null)
    [[ -n "$bucket" && "$bucket" != None ]] && { empty_bucket "$bucket" || true; }
    if [[ -n "$repo" && "$repo" != None ]]; then
      require_ours "$repo"
      aws ecr delete-repository --repository-name "$repo" --force >/dev/null 2>&1 || true
    fi
    delete_stack "$s" || rc=1
    [[ -n "$bucket" && "$bucket" != None ]] && { delete_bucket "$bucket" || rc=1; }
  done
  for s in $(boundary_stacks); do delete_stack "$s" || rc=1; done
  # Managed policies left outside any stack (for example if the CLI created them directly).
  for p in $(aws iam list-policies --scope Local --query "Policies[?starts_with(PolicyName, '$PROJECT-shukka-')].Arn" --output text 2>/dev/null | text_items); do
    require_ours "${p##*/}"
    for v in $(aws iam list-policy-versions --policy-arn "$p" --query 'Versions[?!IsDefaultVersion].VersionId' --output text 2>/dev/null | text_items); do
      aws iam delete-policy-version --policy-arn "$p" --version-id "$v" >/dev/null 2>&1 || true
    done
    aws iam delete-policy --policy-arn "$p" >/dev/null 2>&1 || { log "teardown: policy $p is still attached"; rc=1; }
  done
  for arn in $(aws ecr describe-repositories --query 'repositories[].repositoryName' --output text 2>/dev/null | text_items | grep -E '^cdk-shukkatest-' || true); do
    aws ecr delete-repository --repository-name "$arn" --force >/dev/null 2>&1 || rc=1
  done
  return $rc
}

td_standin() {
  local s b r rc=0
  for s in $(our_stacks | grep -E '^Standin-shukkatest-' || true); do
    b=$(aws cloudformation describe-stack-resources --stack-name "$s" \
      --query "StackResources[?ResourceType=='AWS::S3::Bucket'].PhysicalResourceId | [0]" --output text 2>/dev/null)
    [[ -n "$b" && "$b" != None ]] && { empty_bucket "$b" || true; }
    delete_stack "$s" || rc=1
  done
  for b in $(aws s3api list-buckets --query 'Buckets[].Name' --output text 2>/dev/null | text_items | grep -E '^standin-shukkatest-' || true); do
    delete_bucket "$b" || rc=1
  done
  for b in $(aws dynamodb list-tables --query 'TableNames[]' --output text 2>/dev/null | text_items | grep -E '^standin-shukkatest-' || true); do
    delete_table "$b"
  done
  for b in $(aws sqs list-queues --queue-name-prefix standin-shukkatest- --query 'QueueUrls[]' --output text 2>/dev/null | text_items); do
    require_ours "${b##*/}"
    aws sqs delete-queue --queue-url "$b" || rc=1
  done
  for r in $(aws iam list-roles --query "Roles[?starts_with(RoleName, 'standin-shukkatest-')].RoleName" --output text 2>/dev/null | text_items); do
    require_ours "$r"
    for p in $(aws iam list-role-policies --role-name "$r" --query 'PolicyNames[]' --output text | text_items); do
      aws iam delete-role-policy --role-name "$r" --policy-name "$p" || true
    done
    aws iam delete-role --role-name "$r" || rc=1
  done
  return $rc
}

td_parameters() {
  local x
  for x in $(aws ssm get-parameters-by-path --path "/$PROJECT" --recursive --query 'Parameters[].Name' --output text 2>/dev/null | text_items); do
    aws ssm delete-parameter --name "$x" || true
  done
}

td_zones() {
  local id name rc=0 changes
  while read -r id name; do
    [[ -n "$id" ]] || continue
    id=${id#/hostedzone/}
    require_ours "$name"
    changes=$(aws route53 list-resource-record-sets --hosted-zone-id "$id" --output json |
      jq -c --arg apex "$name" '[.ResourceRecordSets[] | select((.Type == "NS" or .Type == "SOA") and .Name == $apex | not) | {Action: "DELETE", ResourceRecordSet: .}]')
    if [[ "$(jq length <<<"$changes")" != 0 ]]; then
      aws route53 change-resource-record-sets --hosted-zone-id "$id" \
        --change-batch "$(jq -c '{Changes: .}' <<<"$changes")" >/dev/null || rc=1
    fi
    log "teardown: hosted zone $name ($id)"
    if aws route53 delete-hosted-zone --id "$id" >/dev/null; then
      [[ "$id" == "$(state_get zone_id)" ]] && state_set zone_deleted_epoch "$(date +%s)"
    else
      rc=1
    fi
  done < <(aws route53 list-hosted-zones --query 'HostedZones[].[Id,Name]' --output text 2>/dev/null | awk '$2 ~ /^shukkatest-/')
  return $rc
}

# teardown: the whole sequence. Returns non-zero and lists what is left if anything remains.
teardown() {
  local rc=0
  log "teardown: start"
  td_github || rc=1
  if td_project_stacks; then
    td_retained_data
    td_bootstrap || rc=1
  else
    rc=1
    log "teardown: project stacks remain; leaving the shukkatest bootstrap in place so they can still be deleted"
    td_retained_data
  fi
  td_standin || rc=1
  td_parameters
  td_zones || rc=1
  if ! wait_until 900 30 no_leftovers; then
    log "teardown: these throwaway resources are still there:"
    leftovers >&2
    rc=1
  fi
  if [[ $rc == 0 ]]; then log "teardown: clean"; fi
  return $rc
}
