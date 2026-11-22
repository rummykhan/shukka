# shellcheck shell=bash
# Teardown: removes every throwaway resource, found by name and tag (not only from this run's state),
# so it also cleans up after a run that crashed. Every delete goes through require_ours().
# Order matters: project stacks first (CloudFormation deletes them with the project's execution role,
# which the bootstrap stack owns), then retained data, then the bootstrap, then the boundary.
# If project stacks cannot be deleted, the bootstrap is left in place (deleting it would orphan them)
# and reported.

# ---------------------------------------------------------------------------------------------
# Discovery (read-only)

# our_stacks: live stacks whose names mark them as shukkatest's or the stand-in's.
our_stacks() {
  aws cloudformation list-stacks --query "StackSummaries[?StackStatus!='DELETE_COMPLETE'].StackName" \
    --output text 2>/dev/null | tr '\t' '\n' | grep -Ei '^(shukkatest|standin-shukkatest)' || true
}

# is_boundary_stack <stack>: it holds the shukkatest-shukka-* managed policies.
is_boundary_stack() {
  aws cloudformation describe-stack-resources --stack-name "$1" \
    --query "StackResources[?ResourceType=='AWS::IAM::ManagedPolicy'].PhysicalResourceId" --output text 2>/dev/null |
    grep -q "$PROJECT-shukka-"
}

project_stacks() {
  local s q
  q=$(qualifier_stacks)
  for s in $(our_stacks); do
    [[ "$s" =~ ^[Ss]tandin- ]] && continue
    grep -qx -- "$s" <<<"$q" && continue
    is_boundary_stack "$s" && continue
    printf '%s\n' "$s"
  done
}

boundary_stacks() {
  local s q
  q=$(qualifier_stacks)
  for s in $(our_stacks) $(aws cloudformation list-stacks --query "StackSummaries[?StackStatus!='DELETE_COMPLETE'].StackName" --output text 2>/dev/null | tr '\t' '\n' | grep -i shukka || true); do
    grep -qx -- "$s" <<<"$q" && continue
    [[ "$s" == Shukka-Account ]] && continue
    is_boundary_stack "$s" && printf '%s\n' "$s"
  done | sort -u
}

# leftovers: one line per throwaway resource that still exists. Empty means clean.
leftovers() {
  local acct x arn state
  acct=$(aws sts get-caller-identity --query Account --output text 2>/dev/null)
  for x in $(our_stacks) $(qualifier_stacks); do printf 'LEFTOVER stack %s\n' "$x"; done | sort -u
  for x in $(aws s3api list-buckets --query 'Buckets[].Name' --output text 2>/dev/null | tr '\t' '\n' |
    grep -E '^(shukkatest-|cdk-shukkatest-|standin-shukkatest-)' || true); do printf 'LEFTOVER bucket %s\n' "$x"; done
  for x in $(aws dynamodb list-tables --query 'TableNames[]' --output text 2>/dev/null | tr '\t' '\n' |
    grep -E '^(shukkatest|standin-shukkatest)' || true); do printf 'LEFTOVER table %s\n' "$x"; done
  for x in $(aws iam list-roles --query 'Roles[].RoleName' --output text 2>/dev/null | tr '\t' '\n' |
    grep -E '^(shukkatest|Shukkatest|cdk-shukkatest-|standin-shukkatest)' || true); do printf 'LEFTOVER role %s\n' "$x"; done
  for x in $(aws iam list-policies --scope Local --query 'Policies[].PolicyName' --output text 2>/dev/null | tr '\t' '\n' |
    grep -E '^(shukkatest|Shukkatest)' || true); do printf 'LEFTOVER policy %s\n' "$x"; done
  for x in $(aws route53 list-hosted-zones --query 'HostedZones[].[Id,Name]' --output text 2>/dev/null |
    awk '$2 ~ /^shukkatest-/ {sub("/hostedzone/", "", $1); print $1 ":" $2}'); do printf 'LEFTOVER zone %s\n' "$x"; done
  for x in $(aws ssm get-parameters-by-path --path "/$PROJECT" --recursive --query 'Parameters[].Name' --output text 2>/dev/null | tr '\t' '\n' | grep . || true); do
    printf 'LEFTOVER parameter %s\n' "$x"
  done
  for x in $(aws ecr describe-repositories --query 'repositories[].repositoryName' --output text 2>/dev/null | tr '\t' '\n' |
    grep -E '^cdk-shukkatest-' || true); do printf 'LEFTOVER ecr %s\n' "$x"; done
  # Anything still tagged as ours. Terminated instances keep their tags for up to an hour; they are
  # gone for all purposes, so they are not counted.
  for arn in $(aws resourcegroupstaggingapi get-resources --tag-filters "Key=Project,Values=$PROJECT,shukkatest-standin" \
    --query 'ResourceTagMappingList[].ResourceARN' --output text 2>/dev/null | tr '\t' '\n' | grep . || true); do
    if [[ "$arn" == *:instance/* ]]; then
      state=$(aws ec2 describe-instances --instance-ids "${arn##*/}" --query 'Reservations[0].Instances[0].State.Name' --output text 2>/dev/null || echo gone)
      [[ "$state" == terminated || "$state" == gone ]] && continue
    fi
    printf 'LEFTOVER tagged %s\n' "${arn//$acct/123456789012}"
  done
  if [[ "$(state_get account_stack_created 2>/dev/null)" == 1 && "$(stack_status Shukka-Account)" != ABSENT ]]; then
    printf 'LEFTOVER stack Shukka-Account (created by this run)\n'
  fi
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

# delete_stack <name>: deletes and waits; returns non-zero if it is still there.
delete_stack() {
  local s=$1
  if ! is_ours "$s" && ! grep -qx -- "$s" <<<"$(qualifier_stacks)" && ! is_boundary_stack "$s"; then
    die "refusing to delete stack '$s'"
  fi
  [[ "$(stack_status "$s")" == ABSENT ]] && return 0
  log "teardown: stack $s"
  aws cloudformation delete-stack --stack-name "$s" || return 1
  if ! aws cloudformation wait stack-delete-complete --stack-name "$s" 2>/dev/null; then
    log "teardown: stack $s is $(stack_status "$s")"
    aws cloudformation describe-stack-events --stack-name "$s" --max-items 10 \
      --query "StackEvents[?contains(ResourceStatus, 'FAILED')].[LogicalResourceId, ResourceStatusReason]" --output text >&2 || true
    return 1
  fi
}

td_github() {
  if [[ "$(state_get workflow_disabled)" == 1 ]]; then
    gh workflow enable "$CALLER_WORKFLOW" -R "$CONSUMER_REPO" >/dev/null 2>&1 && state_set workflow_disabled 0
  fi
  clean_consumer_github
  gh variable delete SHUKKATEST_GREETING -R "$CONSUMER_REPO" >/dev/null 2>&1 || true
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
  for x in $(aws dynamodb list-tables --query 'TableNames[]' --output text 2>/dev/null | tr '\t' '\n' | grep -E '^shukkatest' || true); do
    delete_table "$x"
  done
  for x in $(aws s3api list-buckets --query 'Buckets[].Name' --output text 2>/dev/null | tr '\t' '\n' | grep -E '^shukkatest-' || true); do
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
  for p in $(aws iam list-policies --scope Local --query "Policies[?starts_with(PolicyName, '$PROJECT-shukka-')].Arn" --output text 2>/dev/null | tr '\t' '\n' | grep . || true); do
    require_ours "${p##*/}"
    for v in $(aws iam list-policy-versions --policy-arn "$p" --query 'Versions[?!IsDefaultVersion].VersionId' --output text 2>/dev/null); do
      aws iam delete-policy-version --policy-arn "$p" --version-id "$v" >/dev/null 2>&1 || true
    done
    aws iam delete-policy --policy-arn "$p" >/dev/null 2>&1 || { log "teardown: policy $p is still attached"; rc=1; }
  done
  for arn in $(aws ecr describe-repositories --query 'repositories[].repositoryName' --output text 2>/dev/null | tr '\t' '\n' | grep -E '^cdk-shukkatest-' || true); do
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
  for b in $(aws s3api list-buckets --query 'Buckets[].Name' --output text 2>/dev/null | tr '\t' '\n' | grep -E '^standin-shukkatest-' || true); do
    delete_bucket "$b" || rc=1
  done
  for b in $(aws dynamodb list-tables --query 'TableNames[]' --output text 2>/dev/null | tr '\t' '\n' | grep -E '^standin-shukkatest-' || true); do
    delete_table "$b"
  done
  for b in $(aws sqs list-queues --queue-name-prefix standin-shukkatest- --query 'QueueUrls[]' --output text 2>/dev/null | tr '\t' '\n' | grep . || true); do
    require_ours "${b##*/}"
    aws sqs delete-queue --queue-url "$b" || rc=1
  done
  for r in $(aws iam list-roles --query "Roles[?starts_with(RoleName, 'standin-shukkatest-')].RoleName" --output text 2>/dev/null | tr '\t' '\n' | grep . || true); do
    require_ours "$r"
    for p in $(aws iam list-role-policies --role-name "$r" --query 'PolicyNames[]' --output text); do
      aws iam delete-role-policy --role-name "$r" --policy-name "$p" || true
    done
    aws iam delete-role --role-name "$r" || rc=1
  done
  return $rc
}

td_parameters() {
  local x
  for x in $(aws ssm get-parameters-by-path --path "/$PROJECT" --recursive --query 'Parameters[].Name' --output text 2>/dev/null | tr '\t' '\n' | grep . || true); do
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

td_account_stack() {
  [[ "$(state_get account_stack_created)" == 1 ]] || return 0
  [[ "$(stack_status Shukka-Account)" == ABSENT ]] && return 0
  # Only delete it if it imports the provider; a stack that owns the provider would delete the
  # account's GitHub OIDC provider, which Trendigle uses.
  if aws cloudformation get-template --stack-name Shukka-Account --query TemplateBody --output json 2>/dev/null |
    grep -Eq 'AWS::IAM::OIDCProvider|OpenIdConnectProvider'; then
    log "teardown: Shukka-Account owns an OIDC provider resource; NOT deleting it (owner must decide)"
    return 1
  fi
  log "teardown: stack Shukka-Account (created by this run, imports the provider)"
  aws cloudformation delete-stack --stack-name Shukka-Account &&
    aws cloudformation wait stack-delete-complete --stack-name Shukka-Account
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
  td_account_stack || rc=1
  if ! wait_until 900 30 no_leftovers; then
    log "teardown: these throwaway resources are still there:"
    leftovers >&2
    rc=1
  fi
  if [[ $rc == 0 ]]; then log "teardown: clean"; fi
  return $rc
}
