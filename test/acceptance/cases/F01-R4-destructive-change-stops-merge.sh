# shellcheck shell=bash
# case: R4-destructive-change-stops-merge
# phase: F
# covers: R4.1 SC5
# title: a merge that replaces the table deploys nothing, goes red, names the resource and says how to proceed

case_run() {
  local run log
  run=$(need_state destructive_run) || return
  log=$(cat "$(run_log "$run")")
  assert_eq "$(run_conclusion "$run")" failure "the merge run is red"
  assert_eq "$(infra_deploy_conclusions "$run")" failure "the infrastructure job stopped (at the guard)"
  assert_cmd "no app deploy job ran" did_not_run "$run" "$JOB_RE_APP"
  assert_cmd "no smoke job ran" did_not_run "$run" "$JOB_RE_SMOKE"
  assert_match "$log" 'Items|shukkatest-items' "the log names the replaced table"
  assert_match "$log" 'allow_replacement' "the log says to rerun with allow_replacement"
  assert_eq "$(need_state after_destructive_box_updated)" "$(need_state before_destructive_box_updated)" "Shukkatest-Box was not updated"
  assert_eq "$(need_state after_destructive_old_table)" ACTIVE "the old table is still there"
  assert_eq "$(need_state after_destructive_new_table)" ABSENT "the new table was not created"
  result R4-step-summary-headings MANUAL "open run $run: the summary must show '### Infrastructure changes' and '### Guard' (no API exposes job summaries)"
}
