# shellcheck shell=bash
# case: R2-tag-cannot-assume-roles
# phase: B
# covers: R2.1
# title: a workflow run from a tag push is refused the infra, app and diff roles (observed AccessDenied)

case_run() {
  local run log r
  run=$(need_state probe_tag_run) || return
  log=$(run_log "$run")
  assert_match "$(grep -Eo 'CLAIMS R2-tag .*' "$log" | head -n 1)" 'refs/tags/shukkatest-probe' "the probe's token is from a tag push"
  for r in infra app diff; do
    expect_observation "$log" "R2-tag-$r" DENIED "$run"
  done
}
