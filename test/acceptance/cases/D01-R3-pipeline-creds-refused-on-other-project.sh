# shellcheck shell=bash
# case: R3-pipeline-creds-refused-on-other-project
# phase: D
# covers: R3.1
# task: shu-9bj.3
# title: the pipeline's roles (infra role, and the project deploy role it reaches) cannot change the stand-in project's stack, table, bucket or queues, nor reach the default deploy role or either lookup role (IAM simulator); the stand-in is untouched by the escape merge

# Since shu-9zr no project code runs while the infra role or the deploy role is held (the merge's
# synth holds nothing: R3-merge-synth-gets-no-credentials), so the suite cannot plant a probe that holds
# them. What they may do is read from IAM with the admin profile. Controls: the infra role may assume
# the project's deploy role, and the deploy role may create a change set on the project's own stack,
# with the same action and context as the refusals beside them. The execution role's own refusal is
# observed for real in R3-execution-role-refuses-other-project.
case_run() {
  local infra deploy exec_role own_stack standin_stack standin_table standin_bucket role p
  local -a st_tag
  infra="arn:aws:iam::$ACCOUNT:role/$PROJECT-shukka-infra"
  deploy="arn:aws:iam::$ACCOUNT:role/cdk-$QUALIFIER-deploy-role-$ACCOUNT-$AWS_REGION"
  exec_role="arn:aws:iam::$ACCOUNT:role/cdk-$QUALIFIER-cfn-exec-role-$ACCOUNT-$AWS_REGION"
  own_stack=$(stack_arn Shukkatest-Box)
  standin_stack=$(stack_arn "$(need_state standin_stack)") || return
  standin_table=$(need_state standin_table) || return
  standin_bucket=$(need_state standin_bucket) || return
  st_tag=("aws:ResourceTag/Project=$PROJECT-standin")

  expect_simulated R3-pipeline-ctl-project-deploy-role ALLOWED "$infra" sts:AssumeRole "$deploy"
  expect_simulated R3-pipeline-default-bootstrap-role DENIED "$infra" sts:AssumeRole \
    "arn:aws:iam::$ACCOUNT:role/cdk-hnb659fds-deploy-role-$ACCOUNT-$AWS_REGION"
  expect_simulated R3-pipeline-project-lookup-role DENIED "$infra" sts:AssumeRole \
    "arn:aws:iam::$ACCOUNT:role/cdk-$QUALIFIER-lookup-role-$ACCOUNT-$AWS_REGION"
  expect_simulated R3-pipeline-default-lookup-role DENIED "$infra" sts:AssumeRole \
    "arn:aws:iam::$ACCOUNT:role/cdk-hnb659fds-lookup-role-$ACCOUNT-$AWS_REGION"
  expect_simulated R3-pipeline-deployrole-ctl-own-stack-changeset ALLOWED "$deploy" cloudformation:CreateChangeSet \
    "$own_stack" "aws:ResourceTag/Project=$PROJECT" "cloudformation:RoleArn=$exec_role"
  expect_simulated R3-pipeline-deployrole-standin-stack-changeset DENIED "$deploy" cloudformation:CreateChangeSet \
    "$standin_stack" "${st_tag[@]}" "cloudformation:RoleArn=$exec_role"

  for p in infra deployrole; do
    if [[ $p == infra ]]; then role=$infra; else role=$deploy; fi
    expect_simulated "R3-pipeline-$p-standin-table-write" DENIED "$role" dynamodb:PutItem \
      "arn:aws:dynamodb:$AWS_REGION:$ACCOUNT:table/$standin_table" "${st_tag[@]}"
    expect_simulated "R3-pipeline-$p-standin-bucket-write" DENIED "$role" s3:PutObject \
      "arn:aws:s3:::$standin_bucket/shukkatest-probe.txt" "${st_tag[@]}"
    expect_simulated "R3-pipeline-$p-standin-queue-create" DENIED "$role" sqs:CreateQueue \
      "arn:aws:sqs:$AWS_REGION:$ACCOUNT:$standin_table-queue"
    expect_simulated "R3-pipeline-$p-standin-stack-update" DENIED "$role" cloudformation:UpdateStack \
      "$standin_stack" "${st_tag[@]}" "cloudformation:RoleArn=$exec_role"
    expect_simulated "R3-pipeline-$p-standin-stack-delete" DENIED "$role" cloudformation:DeleteStack \
      "$standin_stack" "${st_tag[@]}" "cloudformation:RoleArn=$exec_role"
  done
  assert_eq "$(need_state standin_status_after_escape)" CREATE_COMPLETE "the stand-in stack is untouched by the escape merge (status)"
  assert_eq "$(need_state standin_after_escape)" "$(need_state standin_fingerprint)" "the stand-in stack is untouched by the escape merge (never updated)"
}
