# shellcheck shell=bash
# case: R8-cli-rolls-back-unhealthy
# phase: J
# covers: R8.1 SC8 R5.1
# title: shukka deploy runs the same health check and rollback: an unhealthy release leaves the previous one live

case_run() {
  local out old new
  out=$(cat "$RUN_DIR/runs/cli-unhealthy.log" 2>/dev/null)
  old=$(need_state before_cli_unhealthy_web_rev) || return
  new=$(need_state cli_unhealthy_sha) || return
  assert_ne "$(need_state cli_unhealthy_rc)" 0 "shukka deploy exited non-zero"
  assert_eq "$(need_state after_cli_unhealthy_web_rev)" "$old" "web current/REVISION is the previous release"
  assert_match "$out" "$old" "the output names the previous version"
  assert_match "$out" "$new" "the output names the unhealthy version"
  assert_eq "$(need_state cli_restore_rc)" 0 "the healthy release after it deploys"
}
