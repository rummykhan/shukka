# shellcheck shell=bash
# case: R5-unhealthy-release-rolls-back
# phase: G
# covers: R5.1 SC6
# title: an unhealthy release rolls back: the previous release is serving, the run is red, the log shows both versions

case_run() {
  local run log old new
  run=$(need_state unhealthy_run) || return
  new=$(need_state unhealthy_sha) || return
  old=$(need_state before_unhealthy_web_rev) || return
  log=$(cat "$(run_log "$run")")
  # Without a release on the box, "current is the previous release" holds trivially: require it first.
  if ! grep -Eq -- "$(release_line_re web "$old" "$new" rolled-back)" <<<"$log"; then
    fail "the web release of $new ran on the box and rolled back (no release line in the run log)"
    return 1
  fi
  assert_eq "$(run_conclusion "$run")" failure "the run is red"
  assert_cmd "the web app deploy job failed" test "$(job_conclusions "$run" "($JOB_RE_APP).*web|web.*($JOB_RE_APP)")" = failure
  assert_cmd "no smoke job ran" did_not_run "$run" "$JOB_RE_SMOKE"
  assert_eq "$(need_state after_unhealthy_web_rev)" "$old" "web current/REVISION is the previous release"
  assert_match "$(need_state after_unhealthy_http)" "^200 $old" "the live address serves the previous release, healthy"
  assert_match "$log" "shukka: shukkatest/web $old -> $new" "the log shows the release line with both versions"
  assert_match "$log" "$old" "the log names the previous version"
  assert_match "$log" "$new" "the log names the unhealthy version"
}
