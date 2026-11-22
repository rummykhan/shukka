# shellcheck shell=bash
# case: R5-other-app-keeps-running
# phase: G
# covers: R5.4
# title: deploying (and rolling back) one app on a server running two leaves the other app running, unrestarted

case_run() {
  assert_eq "$(need_state after_unhealthy_api_rev)" "$(need_state before_unhealthy_api_rev)" "api release unchanged by the web rollback"
  assert_eq "$(need_state after_restore_api_rev)" "$(need_state before_unhealthy_api_rev)" "api release unchanged by the next web deploy"
  assert_eq "$(need_state after_restore_api_unit)" "$(need_state before_unhealthy_api_unit)" "api unit was never restarted (same start time, active)"
  assert_match "$(need_state after_restore_api_unit)" 'active$' "api unit is active"
  assert_eq "$(http_code "http://$(box_ip):8081/health")" 200 "api answers /health"
}
