# shellcheck shell=bash
# case: R3-default-bootstrap-untouched
# phase: A
# covers: R3 D5
# title: bootstrapping shukkatest left the account's default CDK bootstrap (used by Trendigle and Orbitary) unchanged

case_run() {
  local before
  before=$(need_state default_toolkit_fingerprint) || return
  assert_eq "$(toolkit_fingerprint CDKToolkit)" "$before" "CDKToolkit status, last update and qualifier are unchanged"
  assert_no_match "$(qualifier_stacks)" '^CDKToolkit$' "the shukkatest bootstrap is not in the CDKToolkit stack"
  assert_ne "$(qualifier_stacks)" "" "a separate bootstrap stack with qualifier shukkatest exists"
}
