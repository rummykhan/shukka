# shellcheck shell=bash
# case: R10-shukka-ci-green-on-rc
# phase: K
# covers: R10 SC9
# title: shukka's own CI (lint, types, tests, actionlint, shellcheck, secret scan) is green on the release candidate's commit

case_run() {
  local f
  f="$RUN_DIR/runs/shukka-ci.json"
  [[ -s "$f" ]] || { fail "no record of shukka's CI runs"; return; }
  assert_match "$(jq -r '.[] | select(.workflowName == "test") | .conclusion' "$f")" '^success' "the test workflow succeeded on ${RC_TAG}"
  assert_eq "$(jq '[.[] | select(.workflowName == "test" and .conclusion != "success")] | length' "$f")" 0 "no test run on that commit failed"
}
