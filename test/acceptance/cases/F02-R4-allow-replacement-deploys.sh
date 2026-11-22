# shellcheck shell=bash
# case: R4-allow-replacement-deploys
# phase: F
# covers: R4.2 R4-retain SC5
# title: rerunning by hand with allow_replacement deploys the replacement; the old table is retained

case_run() {
  local run
  run=$(need_state allow_run) || return
  assert_eq "$(run_conclusion "$run")" success "the manual run with allow_replacement is green"
  assert_eq "$(need_state after_allow_new_table)" ACTIVE "the new table exists"
  assert_eq "$(need_state after_allow_old_table)" ACTIVE "the old table was retained, not deleted"
  assert_eq "$(need_state after_allow_box_revision)" "$(need_state destructive_sha)" "Shukkatest-Box carries the merged commit"
}
