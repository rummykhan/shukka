# shellcheck shell=bash
# case: R7-docs-only-merge-deploys-nothing
# phase: E
# covers: R7.2 SC7
# title: a merge that changes only docs runs no deploy job and changes nothing in AWS or on the server

case_run() {
  local run k
  run=$(need_state docs_run) || return
  assert_eq "$(run_conclusion "$run")" success "the docs-only run is green"
  assert_cmd "no infrastructure deploy job ran" infra_deploy_not_run "$run"
  assert_cmd "no app deploy job ran" did_not_run "$run" "$JOB_RE_APP"
  assert_cmd "no smoke job ran" did_not_run "$run" "$JOB_RE_SMOKE"
  for k in box_updated box_revision web_rev api_rev; do
    assert_eq "$(need_state "after_docs_$k")" "$(need_state "before_docs_$k")" "$k unchanged"
  done
}
