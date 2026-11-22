# shellcheck shell=bash
# case: R4-destructive-change-stops-merge
# phase: F
# covers: R4.1 SC5
# title: a merge that replaces the table deploys nothing, goes red, names the resource and says how to proceed

case_run() {
  local run msgs off
  run=$(need_state destructive_run) || return
  # Only what the infrastructure job itself printed (not app jobs, not env/with dumps).
  msgs=$(job_messages "$run" "$JOB_RE_INFRA")
  off=$(guard_offending "$msgs")
  assert_eq "$(run_conclusion "$run")" failure "the merge run is red"
  assert_eq "$(infra_deploy_conclusions "$run")" failure "the infrastructure job stopped (at the guard)"
  assert_cmd "no app deploy job ran" did_not_run "$run" "$JOB_RE_APP"
  assert_cmd "no smoke job ran" did_not_run "$run" "$JOB_RE_SMOKE"
  if grep -Eq -- "$GUARD_STOP_RE" <<<"$msgs"; then ok "the guard printed its stop line (rerun by hand with allow_replacement)"
  else fail "no line '^guard: stopping. ... allow_replacement ticked.' in the infrastructure job"; fi
  if grep -Eq 'AWS::DynamoDB::Table.*Items|Items.*AWS::DynamoDB::Table' <<<"$off"; then ok "the guard's offending lines name the table (Items)"
  else fail "the guard's offending lines do not name the table: $(tr '\n' '|' <<<"$off")"; fi
  assert_eq "$(need_state after_destructive_box_updated)" "$(need_state before_destructive_box_updated)" "Shukkatest-Box was not updated"
  assert_eq "$(need_state after_destructive_old_table)" ACTIVE "the old table is still there"
  assert_eq "$(need_state after_destructive_new_table)" ABSENT "the new table was not created"
  result R4-step-summary-headings MANUAL "open run $run: the summary must show '### Infrastructure changes' and '### Guard' (no API exposes job summaries)"
}
