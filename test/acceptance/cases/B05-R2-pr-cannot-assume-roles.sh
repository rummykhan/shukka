# shellcheck shell=bash
# case: R2-pr-cannot-assume-roles
# phase: B
# covers: R2.1 SC2
# title: a workflow run from a pull request is refused the infra, app and diff roles (observed AccessDenied)

case_run() {
  local run log r
  run=$(need_state probe_pr_run) || return
  log=$(run_log "$run")
  assert_match "$(grep -Eo 'CLAIMS R2-pr .*' "$log" | head -n 1)" 'pull_request' "the probe's token is from a pull request"
  for r in infra app diff; do
    expect_observation "$log" "R2-pr-$r" DENIED "$run"
  done
}
