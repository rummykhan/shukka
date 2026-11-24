# shellcheck shell=bash
# case: R2-checks-job-cannot-assume
# phase: A
# covers: R2.2
# title: code running in the checks job cannot obtain the infra, app or diff role

case_run() {
  local run log r
  run=$(need_state baseline_run) || return
  log=$(run_log "$run")
  for r in infra app diff; do
    expect_observation "$log" "R2-checks-job-$r" DENIED "$run"
  done
}
