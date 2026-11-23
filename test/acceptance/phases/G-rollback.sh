# shellcheck shell=bash
# phase: G
# title: an unhealthy web release, then the fix
# needs: A
# critical: no

phase_G() {
  local sha id
  snapshot before_unhealthy
  printf '{ "healthy": false }\n' >"$RUN_DIR/consumer/apps/web/health.json"
  sha=$(commit_all "shukkatest $RUN_ID: unhealthy web release") || return 1
  push_main || return 1
  state_set unhealthy_sha "$sha"
  id=$(wait_run_of "$sha") && state_set unhealthy_run "$id"
  snapshot after_unhealthy
  state_set after_unhealthy_http "$(http_code "http://$(box_ip):8080/health") $(http_get "http://$(box_ip):8080/version" | one_line)"

  printf '{ "healthy": true }\n' >"$RUN_DIR/consumer/apps/web/health.json"
  sha=$(commit_all "shukkatest $RUN_ID: healthy web release again") || return 1
  push_main || return 1
  state_set restore_sha "$sha"
  id=$(wait_run_of "$sha") && state_set restore_run "$id"
  snapshot after_restore
}
