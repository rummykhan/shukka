# shellcheck shell=bash
# case: R5-next-merge-after-rollback-deploys
# phase: G
# covers: R5.2 D7
# title: after a rollback, the next healthy merge deploys and the server reports it

case_run() {
  local run
  run=$(need_state restore_run) || return
  assert_eq "$(run_conclusion "$run")" success "the fix run is green"
  assert_eq "$(need_state after_restore_web_rev)" "$(need_state restore_sha)" "web current/REVISION is the fix commit"
}
