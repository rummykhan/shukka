# shellcheck shell=bash
# case: R2-build-job-cannot-assume
# phase: A
# covers: R2.2 SC3 trn-a2r
# title: code running in the build job (a compromised build dependency) cannot obtain the infra, app or diff role

case_run() {
  local run log r
  run=$(need_state baseline_run) || return
  log=$(run_log "$run")
  for r in infra app diff; do
    expect_observation "$log" "R2-build-job-$r" DENIED "$run"
  done
}
