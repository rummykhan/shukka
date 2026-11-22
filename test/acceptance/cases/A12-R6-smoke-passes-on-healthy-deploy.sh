# shellcheck shell=bash
# case: R6-smoke-runs-against-live-address
# phase: A
# covers: R6
# title: the smoke command ran after the app deploy, against the live address, and passed

case_run() {
  local run log
  run=$(need_state baseline_run) || return
  log=$(run_log "$run")
  assert_cmd "the smoke job succeeded" ran_successfully "$run" "$JOB_RE_SMOKE"
  assert_match "$(cat "$log")" "smoke: box\\.$(need_state zone_name | sed 's/[.]/\\./g') is $(box_ip | sed 's/[.]/\\./g')" \
    "the smoke test found the box through its DNS record"
  assert_match "$(cat "$log")" 'smoke: ok' "the smoke test passed"
}
