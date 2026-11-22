# shellcheck shell=bash
# case: R6-smoke-failure-turns-run-red
# phase: H
# covers: R6.1
# title: a healthy release whose smoke test fails is live, and the run is red and says it is live but failing smoke

case_run() {
  local run log
  run=$(need_state smoke_run) || return
  log=$(cat "$(run_log "$run")")
  assert_eq "$(run_conclusion "$run")" failure "the run is red"
  assert_cmd "the web app deploy job succeeded" ran_successfully "$run" "($JOB_RE_APP).*web|web.*($JOB_RE_APP)"
  assert_cmd "the smoke job failed" test "$(job_conclusions "$run" "$JOB_RE_SMOKE")" = failure
  assert_eq "$(need_state after_smoke_fail_web_rev)" "$(need_state smoke_sha)" "the new release is live"
  assert_match "$log" 'live.*smoke|smoke.*live' "the run says the site is live but failing its smoke test"
  assert_eq "$(run_conclusion "$(need_state smoke_restore_run)")" success "the fix run is green"
}
