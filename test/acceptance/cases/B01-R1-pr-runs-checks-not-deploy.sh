# shellcheck shell=bash
# case: R1-pr-runs-checks-not-deploy
# phase: B
# covers: R1.1
# title: a pull request runs the checks and deploys nothing

case_run() {
  local run
  run=$(need_state pr_run1) || return
  assert_eq "$(run_conclusion "$run")" success "the pull-request run is green"
  assert_cmd "a checks job ran and succeeded" ran_successfully "$run" "$JOB_RE_CHECKS"
  assert_cmd "no infrastructure deploy job ran" infra_deploy_not_run "$run"
  assert_cmd "no app deploy job ran" did_not_run "$run" "$JOB_RE_APP"
  assert_cmd "no smoke job ran" did_not_run "$run" "$JOB_RE_SMOKE"
  assert_eq "$(need_state after_pr_box_updated)" "$(need_state before_pr_box_updated)" "Shukkatest-Box was not updated"
  assert_eq "$(need_state after_pr_web_rev)" "$(need_state before_pr_web_rev)" "the server still runs the same web release"
}
