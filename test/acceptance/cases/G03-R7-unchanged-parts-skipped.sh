# shellcheck shell=bash
# case: R7-unchanged-parts-skipped
# phase: G
# covers: R7 D7
# title: a merge that changes only the web app deploys only the web app (no infrastructure deploy, no api deploy)

case_run() {
  local run
  run=$(need_state restore_run) || return
  assert_cmd "the web app deploy job ran and succeeded" ran_successfully "$run" "($JOB_RE_APP).*web|web.*($JOB_RE_APP)"
  assert_cmd "the api app deploy job did not run" did_not_run "$run" "($JOB_RE_APP).*api|api.*($JOB_RE_APP)"
  assert_cmd "no infrastructure deploy job ran" infra_deploy_not_run "$run"
}
