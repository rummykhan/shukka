# shellcheck shell=bash
# case: R2-branch-cannot-assume-roles
# phase: B
# covers: R2.1
# title: a workflow run from a push to a branch other than main is refused the infra, app and diff roles (observed AccessDenied)

case_run() {
  local run log r
  run=$(need_state probe_branch_run) || return
  log=$(run_log "$run")
  assert_match "$(grep -Eo 'CLAIMS R2-branch .*' "$log" | head -n 1)" 'refs/heads/shukkatest-probe' "the probe's token is from a push to a branch other than main"
  for r in infra app diff; do
    expect_observation "$log" "R2-branch-$r" DENIED "$run"
  done
}
