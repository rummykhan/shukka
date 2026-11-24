# shellcheck shell=bash
# case: R8-cli-refuses-unclean-checkout
# phase: J
# covers: R8.1 C7
# title: shukka deploy refuses a dirty working tree and a commit that is not origin/main, and deploys nothing

case_run() {
  assert_ne "$(need_state cli_dirty_rc)" 0 "refused with uncommitted changes"
  assert_ne "$(need_state cli_ahead_rc)" 0 "refused when HEAD is not origin/main"
  assert_eq "$(need_state before_cli_guard_web_rev)" "$(need_state after_cli_web_rev)" "nothing was deployed by the refused attempts"
}
