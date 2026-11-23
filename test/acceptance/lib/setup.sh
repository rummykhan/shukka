# shellcheck shell=bash
# Setup for the acceptance run (phase A). Every resource created here is recorded in the state file
# the moment it exists, so teardown can remove it even if setup stops half-way. Written for the
# bash 3.2 that ships with macOS (no associative arrays, no mapfile).

setup_preflight() {
  local t
  for t in gh aws jq git node npm npx curl; do
    command -v "$t" >/dev/null 2>&1 || die "missing tool: $t"
  done
  gh auth status >/dev/null 2>&1 || die "gh is not signed in"
  ACCOUNT=$(aws sts get-caller-identity --query Account --output text) ||
    die "AWS profile '$AWS_PROFILE' does not work"
  if [[ -n "${SHUKKATEST_EXPECT_ACCOUNT:-}" && "$ACCOUNT" != "$SHUKKATEST_EXPECT_ACCOUNT" ]]; then
    die "profile '$AWS_PROFILE' is account $ACCOUNT, not SHUKKATEST_EXPECT_ACCOUNT"
  fi
  state_set account "$ACCOUNT"
  log "AWS account from profile '$AWS_PROFILE', region $AWS_REGION (account id not printed)"

  setup_check_tag
  RC_SHA=$(gh api "repos/$SHUKKA_REPO/commits/$RC_TAG" --jq .sha 2>/dev/null) ||
    die "tag $RC_TAG does not exist in $SHUKKA_REPO"
  state_set rc_sha "$RC_SHA"
  log "shukka $RC_TAG is ${RC_SHA:0:12}"

  local vis
  vis=$(gh repo view "$CONSUMER_REPO" --json visibility -q .visibility 2>/dev/null) ||
    die "test consumer $CONSUMER_REPO does not exist or is not readable"
  [[ "$vis" == PRIVATE ]] || die "test consumer $CONSUMER_REPO must be private (it is $vis)"

  local left
  left=$(leftovers)
  if [[ -n "$left" ]]; then
    printf '%s\n' "$left" >&2
    die "shukkatest resources from an earlier run still exist; run 'bash test/acceptance/run.sh --teardown' first"
  fi
}

# GitHub does not start a caller of pipeline.yml pinned to an annotated tag ("workflow file issue",
# no jobs): it resolves pipeline.yml's nested ./.github/workflows/ calls at the tag object, not at the
# commit. Release tags are lightweight (git tag <name> <sha>, no -a, -s or -m).
setup_check_tag() {
  local type
  type=$(gh api "repos/$SHUKKA_REPO/git/ref/tags/$RC_TAG" --jq .object.type 2>/dev/null) ||
    die "tag $RC_TAG does not exist in $SHUKKA_REPO"
  [[ "$type" == commit ]] ||
    die "tag $RC_TAG is an annotated tag; GitHub will not start pipeline.yml from it (nested ./ workflow calls). Recreate it as a lightweight tag: git tag -f $RC_TAG $RC_TAG^{commit} && git push -f origin refs/tags/$RC_TAG"
}

setup_discover() {
  local vpc azs subnet az ami providers n subject
  vpc=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)
  [[ "$vpc" == vpc-* ]] || die "no default VPC in $AWS_REGION (the test box uses it to avoid creating one)"
  azs=$(aws ec2 describe-instance-type-offerings --location-type availability-zone \
    --filters Name=instance-type,Values=t4g.nano --query 'InstanceTypeOfferings[].Location' --output text)
  subnet=""
  az=""
  while read -r sid saz; do
    if grep -qw -- "$saz" <<<"$azs"; then subnet=$sid az=$saz; break; fi
  done < <(aws ec2 describe-subnets --filters "Name=vpc-id,Values=$vpc" Name=default-for-az,Values=true \
    --query 'Subnets[].[SubnetId,AvailabilityZone]' --output text)
  [[ -n "$subnet" ]] || die "no default subnet in an AZ that offers t4g.nano"
  ami=$(aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64 \
    --query Parameter.Value --output text) || die "cannot read the Amazon Linux 2023 AMI parameter"
  state_set vpc_id "$vpc"
  state_set subnet_id "$subnet"
  state_set az "$az"
  state_set ami_id "$ami"

  # The account's GitHub OIDC provider: exactly one must exist (Trendigle's); the suite imports it.
  providers=$(aws iam list-open-id-connect-providers --query 'OpenIDConnectProviderList[].Arn' --output text |
    tr '\t' '\n' | grep 'token.actions.githubusercontent.com' || true)
  n=$(grep -c . <<<"$providers" || true)
  [[ "$n" == 1 ]] || die "expected exactly one GitHub OIDC provider in the account, found $n"
  state_set oidc_provider_arn "$providers"
  state_set oidc_provider_count_before "$n"

  # The default CDK bootstrap (Trendigle's and Orbitary's today) must come through untouched.
  state_set default_toolkit_fingerprint "$(toolkit_fingerprint CDKToolkit)"

  # Trendigle names for the read-only refusal checks: discovered, never written.
  local tt tb
  tt=${SHUKKATEST_TRENDIGLE_TABLE:-$(aws dynamodb list-tables --query "TableNames[?starts_with(@, 'trendigle')] | [0]" --output text)}
  tb=${SHUKKATEST_TRENDIGLE_BUCKET:-$(aws s3api list-buckets --query "Buckets[?starts_with(Name, 'trendigle')].Name | [0]" --output text)}
  [[ -n "$tt" && "$tt" != None ]] || die "no Trendigle table found for the read-only refusal check"
  [[ -n "$tb" && "$tb" != None ]] || die "no Trendigle bucket found for the read-only refusal check"
  state_set trendigle_table "$tt"
  state_set trendigle_bucket "$tb"

  subject=${SHUKKATEST_GITHUB_REPO_SUBJECT:-$(gh api "repos/$CONSUMER_REPO" --jq '"\(.owner.login)@\(.owner.id)/\(.name)@\(.id)"')}
  state_set github_repo_subject "$subject"
}

# toolkit_fingerprint <stack>: status, last update and qualifier of a bootstrap stack, or ABSENT.
toolkit_fingerprint() {
  aws cloudformation describe-stacks --stack-name "$1" \
    --query "Stacks[0].[StackStatus, LastUpdatedTime || CreationTime, Parameters[?ParameterKey=='Qualifier'].ParameterValue | [0]]" \
    --output text 2>/dev/null | tr '\t' ' ' || printf 'ABSENT\n'
}

setup_zone() {
  local name out id ns
  name=${SHUKKATEST_ZONE_DOMAIN:-shukkatest-$RUN_ID.com}
  out=$(aws route53 create-hosted-zone --name "$name" --caller-reference "shukkatest-$RUN_ID" \
    --hosted-zone-config "$(jq -nc --arg c "shukka acceptance $RUN_ID, delete within 12 hours" '{Comment: $c}')" \
    --query '[HostedZone.Id, DelegationSet.NameServers[0]]' --output text) || die "cannot create hosted zone $name"
  id=$(awk '{print $1}' <<<"$out")
  id=${id#/hostedzone/}
  ns=$(awk '{print $2}' <<<"$out")
  state_set zone_id "$id"
  state_set zone_name "$name"
  state_set zone_ns "$ns"
  state_set zone_created_epoch "$(date +%s)"
  aws route53 change-tags-for-resource --resource-type hostedzone --resource-id "$id" \
    --add-tags Key=Project,Value="$PROJECT" Key=ShukkatestRun,Value="$RUN_ID" ||
    log "warning: could not tag hosted zone $id"
  log "throwaway hosted zone $name ($id)"
}

setup_param() {
  local value="hello from shukkatest run $RUN_ID"
  aws ssm put-parameter --name "/$PROJECT/prod/SHUKKATEST_GREETING" --type String --value "$value" \
    --tags Key=Project,Value="$PROJECT" >/dev/null || die "cannot create the buildEnv parameter"
  state_set greeting "$value"
}

# The stand-in "other project" (in place of Orbitary): a table and a bucket in a stack with its own
# CloudFormation service role, like Trendigle's and Orbitary's stacks. Names start with
# standin-shukkatest, so shukkatest's name-prefix fence does not cover them.
setup_standin() {
  local base="standin-shukkatest-$RUN_ID" stack role role_arn
  stack="Standin-shukkatest-$RUN_ID"
  role="$base-cfn"
  state_set standin_stack "$stack"
  state_set standin_table "$base"
  state_set standin_bucket "$base-$ACCOUNT"
  state_set standin_role "$role"
  role_arn=$(aws iam create-role --role-name "$role" \
    --assume-role-policy-document "file://$ACCEPT_DIR/fixtures/standin-role-trust.json" \
    --tags Key=Project,Value=shukkatest-standin \
    --query Role.Arn --output text) || die "cannot create the stand-in's service role"
  aws iam put-role-policy --role-name "$role" --policy-name standin-resources \
    --policy-document "file://$ACCEPT_DIR/fixtures/standin-role-policy.json" || die "cannot attach the stand-in role policy"
  sleep 15 # IAM propagation before CloudFormation can assume the new role
  wait_until 120 15 aws cloudformation create-stack --stack-name "$stack" --role-arn "$role_arn" \
    --template-body "file://$ACCEPT_DIR/fixtures/standin-template.json" \
    --parameters "ParameterKey=TableName,ParameterValue=$base" "ParameterKey=BucketName,ParameterValue=$base-$ACCOUNT" \
    --tags Key=Project,Value=shukkatest-standin >/dev/null || die "cannot create the stand-in stack"
  aws cloudformation wait stack-create-complete --stack-name "$stack" || die "stand-in stack did not create"
  state_set standin_fingerprint "$(stack_last_updated "$stack")"
  log "stand-in project $stack ready"
}

# setup_render: the consumer's contents with this run's values, in a fresh clone of the test repo.
setup_render() {
  local dir="$RUN_DIR/consumer" email
  rm -rf "$dir"
  gh repo clone "$CONSUMER_REPO" "$dir" -- -q || die "cannot clone $CONSUMER_REPO"
  email=$(gh api user --jq '"\(.id)+\(.login)@users.noreply.github.com"')
  c_git config user.name "shukka acceptance"
  c_git config user.email "$email"
  c_git rm -rq --ignore-unmatch . >/dev/null 2>&1 || true
  (cd "$ACCEPT_DIR/consumer" && tar -cf - .) | (cd "$dir" && tar -xf -)
  render_tree "$dir"
}

# render_tree <dir>: replaces __KEY__ placeholders in every file with this run's values.
render_tree() {
  local dir=$1 f content pair key value
  local pairs=(
    "ACCOUNT=$ACCOUNT"
    "REGION=$AWS_REGION"
    "RUN_ID=$RUN_ID"
    "SHUKKA_REF=$RC_TAG"
    "GITHUB_REPO_SUBJECT=$(state_get github_repo_subject)"
    "OIDC_PROVIDER_ARN=$(state_get oidc_provider_arn)"
    "ZONE_ID=$(state_get zone_id)"
    "ZONE_NAME=$(state_get zone_name)"
    "ZONE_NS=$(state_get zone_ns)"
    "VPC_ID=$(state_get vpc_id)"
    "SUBNET_ID=$(state_get subnet_id)"
    "AZ=$(state_get az)"
    "AMI_ID=$(state_get ami_id)"
    "STANDIN_STACK=$(state_get standin_stack)"
    "STANDIN_TABLE=$(state_get standin_table)"
    "STANDIN_BUCKET=$(state_get standin_bucket)"
    "TRENDIGLE_TABLE=$(state_get trendigle_table)"
    "TRENDIGLE_BUCKET=$(state_get trendigle_bucket)"
    "INFRA_MODE_INPUT=${SHUKKATEST_INFRA_MODE_INPUT:-mode}"
  )
  while IFS= read -r -d '' f; do
    content=$(cat "$f")
    for pair in "${pairs[@]}"; do
      key=${pair%%=*}
      value=${pair#*=}
      content=${content//"__${key}__"/"$value"}
    done
    printf '%s\n' "$content" >"$f"
  done < <(find "$dir" -type f -not -path '*/.git/*' -not -path '*/node_modules/*' -print0)
  if grep -rEl '__[A-Z][A-Z_]+__' --exclude-dir=.git --exclude-dir=node_modules "$dir" >&2; then
    die "unrendered placeholders in the files above"
  fi
}

setup_bootstrap_project() {
  state_set project_bootstrap_started 1
  cli_bootstrap_project "$RUN_DIR/consumer" "$(state_get zone_id)" || die "shukka bootstrap $PROJECT failed"
  [[ -n "$(qualifier_stacks)" ]] || die "no bootstrap stack with qualifier $QUALIFIER after shukka bootstrap"
}

# qualifier_stacks: the project's bootstrap stack(s): CDKToolkit-shukkatest (shukka's own template,
# which takes no Qualifier parameter), a stack with a Qualifier parameter of shukkatest, or a
# shukkatest-named stack that holds the /cdk-bootstrap/shukkatest/ version parameter.
qualifier_stacks() {
  local s
  {
    aws cloudformation describe-stacks \
      --query "Stacks[?Parameters[?ParameterKey=='Qualifier' && ParameterValue=='$QUALIFIER']].StackName" \
      --output text 2>/dev/null | text_items
    for s in $(our_stacks); do
      [[ "$s" == "$BOUNDARY_STACK" ]] && continue
      if [[ "$s" == "$BOOTSTRAP_STACK" ]]; then printf '%s\n' "$s"; continue; fi
      if aws cloudformation describe-stack-resources --stack-name "$s" \
        --query "StackResources[?ResourceType=='AWS::SSM::Parameter'].PhysicalResourceId" --output text 2>/dev/null |
        grep -q "/cdk-bootstrap/$QUALIFIER/"; then
        printf '%s\n' "$s"
      fi
    done
  } | grep . | sort -u || true
}

# The Ci stack (ShukkaAccess) is deployed by hand with admin credentials, as a consumer does before its
# first merge and after every change to it (README step 5). It uses shukkaCiSynthesizer: CloudFormation
# acts with these admin credentials, not the fenced execution role, which may not change the CI roles
# (NoChangeToCiRoles); the pipeline never deploys it.
setup_ci_stack() {
  local infra="$RUN_DIR/consumer/infra"
  (cd "$infra" && npm install --no-audit --no-fund --loglevel=error) || die "npm install in the consumer's infra failed"
  state_set ci_stack_started 1
  (cd "$infra" && npx cdk deploy Shukkatest-Ci --require-approval never --progress events) ||
    die "deploying Shukkatest-Ci by hand failed"
  local r role
  for r in infra app diff; do
    aws iam get-role --role-name "$PROJECT-shukka-$r" >/dev/null 2>&1 || die "role $PROJECT-shukka-$r was not created"
  done
  role=$(aws cloudformation describe-stacks --stack-name Shukkatest-Ci --query 'Stacks[0].RoleARN' --output text 2>/dev/null)
  [[ "$role" == None || -z "$role" ]] || die "Shukkatest-Ci was deployed through a CloudFormation role ($role), not the admin's own credentials"
}

# Clean the test repository of earlier probes, then push the baseline as the first merge to main.
setup_push_baseline() {
  clean_consumer_github
  local sha id
  sha=$(commit_all "shukkatest $RUN_ID: consumer baseline")
  require_consumer_remote
  # Teardown of an earlier run leaves the caller disabled; enable it, and wait until it is active, so
  # this merge runs.
  enable_workflow "$CALLER_WORKFLOW"
  c_git push -q --force origin HEAD:main || die "cannot push the baseline to $CONSUMER_REPO"
  state_set baseline_sha "$sha"
  id=$(wait_run_of "$sha") ||
    die "no CI run for the baseline merge $sha; caller '$CALLER_WORKFLOW' is $(workflow_state "$CALLER_WORKFLOW")"
  state_set baseline_run "$id"
}

# clean_consumer_github: close probe PRs, delete probe branches and tags in the test repository.
clean_consumer_github() {
  local n ref
  for n in $(gh pr list -R "$CONSUMER_REPO" --state open --json number,headRefName \
    -q '.[] | select(.headRefName | startswith("shukkatest-")) | .number' 2>/dev/null); do
    gh pr close "$n" -R "$CONSUMER_REPO" --delete-branch >/dev/null 2>&1 || true
  done
  for ref in $(gh api "repos/$CONSUMER_REPO/git/matching-refs/heads/shukkatest-" --jq '.[].ref' 2>/dev/null) \
    $(gh api "repos/$CONSUMER_REPO/git/matching-refs/tags/shukkatest-" --jq '.[].ref' 2>/dev/null); do
    gh api -X DELETE "repos/$CONSUMER_REPO/git/${ref#refs/}" >/dev/null 2>&1 || true
  done
}
