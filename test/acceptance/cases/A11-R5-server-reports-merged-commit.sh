# shellcheck shell=bash
# case: R5-server-reports-merged-commit
# phase: A
# covers: R5.2
# title: after a successful deploy the server reports the merged commit for each app

case_run() {
  local sha
  sha=$(need_state baseline_sha) || return
  assert_eq "$(need_state after_baseline_web_rev)" "$sha" "web current/REVISION is the merged commit"
  assert_eq "$(need_state after_baseline_api_rev)" "$sha" "api current/REVISION is the merged commit"
  assert_eq "$(http_get "http://$(box_ip):8081/version" | tr -d '[:space:]')" "$sha" "api /version on the live address is the merged commit"
}
