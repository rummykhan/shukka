# shellcheck shell=bash
# case: R1-build-env-from-variables
# phase: A
# covers: R1.1 D9
# title: shukka bootstrap copied the buildEnv value to a repository variable and the build used it

case_run() {
  local g ip
  g=$(need_state greeting) || return
  assert_eq "$(gh variable get SHUKKATEST_GREETING -R "$CONSUMER_REPO" 2>/dev/null)" "$g" \
    "repository variable SHUKKATEST_GREETING holds /shukkatest/prod/SHUKKATEST_GREETING"
  ip=$(box_ip)
  assert_match "$(http_get "http://$ip:8080/")" "greeting: $g" "the deployed web page carries the build-time value"
}
