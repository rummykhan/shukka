# shellcheck shell=bash
# case: R4-pr-code-gets-no-write-credentials
# phase: B
# covers: R4.3 SC2 R3.1
# task: shu-9bj.3
# title: the role the pull-request diff runs under (shukka's code only) can change nothing, own or other project, and cannot read Trendigle (IAM simulator)

# Since shu-9zr the pull request's own code runs in a synth job with no credentials at all
# (R4-pr-synth-gets-no-credentials); the diff role is held only by the diff job, which runs shukka's
# own cdk on the assembly. No code the suite can plant holds that role, so what it may do is read from
# IAM with the admin profile. The control (GetTemplate on its own stack) must be allowed.
case_run() {
  local diff own_stack own_bucket own_table standin_stack standin_table standin_bucket tt tb
  local -a own_tag standin_tag
  diff="arn:aws:iam::$ACCOUNT:role/$PROJECT-shukka-diff"
  own_stack=$(stack_arn Shukkatest-Box)
  own_bucket="$PROJECT-deploy-$ACCOUNT"
  own_table="$PROJECT-items"
  standin_stack=$(stack_arn "$(need_state standin_stack)") || return
  standin_table=$(need_state standin_table) || return
  standin_bucket=$(need_state standin_bucket) || return
  tt=$(need_state trendigle_table) || return
  tb=$(need_state trendigle_bucket) || return
  own_tag=("aws:ResourceTag/Project=$PROJECT")
  standin_tag=("aws:ResourceTag/Project=$PROJECT-standin")

  expect_simulated R4-prdiff-ctl-get-template ALLOWED "$diff" cloudformation:GetTemplate "$own_stack" "${own_tag[@]}"
  expect_simulated R4-prdiff-project-deploy-role DENIED "$diff" sts:AssumeRole \
    "arn:aws:iam::$ACCOUNT:role/cdk-$QUALIFIER-deploy-role-$ACCOUNT-$AWS_REGION"
  expect_simulated R4-prdiff-deploy-bucket-write DENIED "$diff" s3:PutObject "arn:aws:s3:::$own_bucket/shukkatest/probe.txt" "${own_tag[@]}"
  expect_simulated R4-prdiff-table-write DENIED "$diff" dynamodb:PutItem \
    "arn:aws:dynamodb:$AWS_REGION:$ACCOUNT:table/$own_table" "${own_tag[@]}"
  expect_simulated R4-prdiff-stack-update DENIED "$diff" cloudformation:UpdateStack "$own_stack" "${own_tag[@]}"
  expect_simulated R4-prdiff-stack-changeset DENIED "$diff" cloudformation:CreateChangeSet "$own_stack" "${own_tag[@]}"
  expect_simulated R4-prdiff-send-command DENIED "$diff" ssm:SendCommand \
    "arn:aws:ec2:$AWS_REGION:$ACCOUNT:instance/i-00000000000000000" "${own_tag[@]}"
  expect_simulated R4-prdiff-standin-table-write DENIED "$diff" dynamodb:PutItem \
    "arn:aws:dynamodb:$AWS_REGION:$ACCOUNT:table/$standin_table" "${standin_tag[@]}"
  expect_simulated R4-prdiff-standin-bucket-write DENIED "$diff" s3:PutObject "arn:aws:s3:::$standin_bucket/shukkatest-probe.txt" "${standin_tag[@]}"
  expect_simulated R4-prdiff-standin-queue-create DENIED "$diff" sqs:CreateQueue \
    "arn:aws:sqs:$AWS_REGION:$ACCOUNT:$standin_table-queue"
  expect_simulated R4-prdiff-standin-stack-update DENIED "$diff" cloudformation:UpdateStack "$standin_stack" "${standin_tag[@]}"
  expect_simulated R4-prdiff-standin-stack-delete DENIED "$diff" cloudformation:DeleteStack "$standin_stack" "${standin_tag[@]}"
  expect_simulated R4-prdiff-trendigle-table-read DENIED "$diff" dynamodb:DescribeTable \
    "arn:aws:dynamodb:$AWS_REGION:$ACCOUNT:table/$tt"
  expect_simulated R4-prdiff-trendigle-bucket-read DENIED "$diff" s3:ListBucket "arn:aws:s3:::$tb"
}
