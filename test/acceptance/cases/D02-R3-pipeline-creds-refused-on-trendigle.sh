# shellcheck shell=bash
# case: R3-pipeline-creds-refused-on-trendigle
# phase: D
# covers: R3.1 SC4
# task: shu-9bj.3
# title: shukkatest's pipeline roles (infra role and project deploy role) are refused on a Trendigle table and bucket (IAM simulator, read actions)

# Read from IAM with the admin profile, for the reason given in R3-pipeline-creds-refused-on-other-project.
# The box role's refusal on Trendigle is observed for real from the box (R3-box-role-refused-on-trendigle).
case_run() {
  local tt tb p role
  tt=$(need_state trendigle_table) || return
  tb=$(need_state trendigle_bucket) || return
  for p in infra deployrole; do
    if [[ $p == infra ]]; then role="arn:aws:iam::$ACCOUNT:role/$PROJECT-shukka-infra"
    else role="arn:aws:iam::$ACCOUNT:role/cdk-$QUALIFIER-deploy-role-$ACCOUNT-$AWS_REGION"; fi
    expect_simulated "R3-pipeline-$p-trendigle-table-read" DENIED "$role" dynamodb:DescribeTable \
      "arn:aws:dynamodb:$AWS_REGION:$ACCOUNT:table/$tt"
    expect_simulated "R3-pipeline-$p-trendigle-bucket-read" DENIED "$role" s3:ListBucket "arn:aws:s3:::$tb"
  done
}
