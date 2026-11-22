# shellcheck shell=bash
# case: R8-cli-guard-stops-destructive
# phase: J
# covers: R8.1 SC8 R4.1
# title: shukka deploy runs the same guard: a table replacement stops it and nothing is deployed

case_run() {
  local out
  out=$(cat "$RUN_DIR/runs/cli-guard.log" 2>/dev/null)
  assert_ne "$(need_state cli_guard_rc)" 0 "shukka deploy exited non-zero"
  if grep -Fxq -- "$GUARD_HEADER" <<<"$out" && grep -Eq 'AWS::DynamoDB::Table.*Items|Items.*AWS::DynamoDB::Table' <<<"$(guard_offending "$out")"; then
    ok "the guard's output names the replaced table"
  else
    fail "no guard output naming the table (Items) in shukka deploy's output"
  fi
  assert_eq "$(need_state cli_guard_new_table)" ABSENT "the replacement table was not created"
  assert_eq "$(need_state after_cli_guard_box_updated)" "$(need_state before_cli_guard_box_updated)" "Shukkatest-Box was not updated"
}
