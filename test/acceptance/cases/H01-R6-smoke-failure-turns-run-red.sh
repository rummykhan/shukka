# shellcheck shell=bash
# case: R6-smoke-failure-turns-run-red
# phase: H
# covers: R6.1
# title: a healthy release whose smoke test fails is live, and the run is red and says it is live but failing smoke

case_run() {
  local run msgs
  run=$(need_state smoke_run) || return
  msgs=$(job_messages "$run" "$JOB_RE_SMOKE")
  assert_eq "$(run_conclusion "$run")" failure "the run is red"
  assert_cmd "the web app deploy job succeeded" ran_successfully "$run" "($JOB_RE_APP).*web|web.*($JOB_RE_APP)"
  assert_cmd "the smoke job failed" test "$(job_conclusions "$run" "$JOB_RE_SMOKE")" = failure
  assert_eq "$(need_state after_smoke_fail_web_rev)" "$(need_state smoke_sha)" "the new release is live"
  if grep -Eq -- "$SMOKE_FAILED_RE" <<<"$msgs"; then ok "the smoke job says the site is live but failing its smoke test"
  else fail "no line '^shukka: the site is live but failing its smoke test' in the smoke job"; fi
  assert_match "$msgs" 'smoke: the web page has lost its marker' "the project's own smoke output is in the smoke job"
  assert_eq "$(run_conclusion "$(need_state smoke_restore_run)")" success "the fix run is green"
}
