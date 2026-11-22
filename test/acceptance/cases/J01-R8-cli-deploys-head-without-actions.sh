# shellcheck shell=bash
# case: R8-cli-deploys-head-without-actions
# phase: J
# covers: R8.1 SC8
# title: with the caller workflow disabled, shukka deploy from this machine deploys the merged commit

case_run() {
  local sha
  sha=$(need_state cli_sha) || return
  assert_eq "$(need_state cli_runs_for_sha)" 0 "no GitHub Actions run took part"
  assert_eq "$(need_state cli_deploy_rc)" 0 "shukka deploy exited 0"
  assert_eq "$(need_state after_cli_web_rev)" "$sha" "web current/REVISION is the merged commit"
  assert_match "$(http_get "http://$(box_ip):8080/")" "revision: $sha" "the live address serves it"
}
