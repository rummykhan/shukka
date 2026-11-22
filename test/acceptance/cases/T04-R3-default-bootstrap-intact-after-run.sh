# shellcheck shell=bash
# case: R3-default-bootstrap-intact-after-run
# phase: T
# covers: R3 safety
# title: the account's default CDK bootstrap is exactly as it was before the run

case_run() {
  assert_eq "$(toolkit_fingerprint CDKToolkit)" "$(need_state default_toolkit_fingerprint)" "CDKToolkit unchanged"
}
