# shellcheck shell=bash
# case: R2-tag-cannot-assume-roles
# phase: B
# covers: R2.1
# task: shu-9bj.3
# title: a workflow run from a tag push is refused the infra, app and diff roles and the CDK deploy and lookup roles (observed AccessDenied)

case_run() {
  local run log r
  run=$(need_state probe_tag_run) || return
  log=$(run_log "$run")
  assert_match "$(grep -Eo 'CLAIMS R2-tag .*' "$log" | head -n 1)" 'refs/tags/shukkatest-probe' "the probe's token is from a tag push"
  # shukka's roles, and the CDK roles a GitHub token must never reach directly (shu-9bj.3).
  for r in infra app diff cdk-deploy cdk-lookup default-deploy default-lookup; do
    expect_observation "$log" "R2-tag-$r" DENIED "$run"
  done
}
