# shellcheck shell=bash
# case: R4-pr-code-gets-no-write-credentials
# phase: B
# covers: R4.3 SC2 R3.1
# title: the pull request's own CDK code, holding the diff credentials, can change nothing (own or other project) and cannot read Trendigle

case_run() {
  local run log o
  run=$(need_state pr_run1) || return
  log=$(run_log "$run")
  # Control: the probe really held the diff role (it can read its own template).
  expect_observation "$log" R4-prdiff-ctl-get-template ALLOWED "$run"
  for o in project-deploy-role deploy-bucket-write table-write stack-update send-command \
    standin-table-write standin-bucket-write standin-queue-create standin-stack-update standin-stack-delete \
    trendigle-table-read trendigle-bucket-read; do
    expect_observation "$log" "R4-prdiff-$o" DENIED "$run"
  done
}
