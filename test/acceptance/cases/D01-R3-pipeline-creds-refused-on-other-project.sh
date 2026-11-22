# shellcheck shell=bash
# case: R3-pipeline-creds-refused-on-other-project
# phase: D
# covers: R3.1
# title: the pipeline's credentials (infra role, and the project deploy role it can reach) cannot change the stand-in project's stack, table, bucket or queues, nor reach the default deploy role or either lookup role

case_run() {
  local run log p o
  run=$(need_state escape_run) || return
  log=$(run_log "$run")
  # Control: the credentials were the real pipeline's (they reach the project's own deploy role).
  expect_observation "$log" R3-pipeline-ctl-project-deploy-role ALLOWED "$run"
  expect_observation "$log" R3-pipeline-default-bootstrap-role DENIED "$run"
  expect_observation "$log" R3-pipeline-project-lookup-role DENIED "$run"
  expect_observation "$log" R3-pipeline-default-lookup-role DENIED "$run"
  for p in R3-pipeline-infra R3-pipeline-deployrole; do
    for o in standin-table-write standin-bucket-write standin-queue-create standin-stack-update standin-stack-delete; do
      expect_observation "$log" "$p-$o" DENIED "$run"
    done
  done
  assert_eq "$(need_state standin_status_after_escape)" CREATE_COMPLETE "the stand-in stack is untouched (status)"
  assert_eq "$(need_state standin_after_escape)" "$(need_state standin_fingerprint)" "the stand-in stack is untouched (never updated)"
}
