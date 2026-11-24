# shellcheck shell=bash
# case: R4-pr-diff-comment-updated-in-place
# phase: B
# covers: R4.3 R4.1
# title: a destructive push to the same pull request updates the same comment, says the merge will stop, and does not fail the check

case_run() {
  local c1 c2 run body
  c1=$(need_state pr_comments1) || return
  c2=$(need_state pr_comments2) || return
  run=$(need_state pr_run2) || return
  assert_eq "$(jq length <<<"$c2")" 1 "still exactly one marked comment"
  assert_eq "$(jq -r '.[0].id' <<<"$c2")" "$(jq -r '.[0].id' <<<"$c1")" "it is the same comment"
  assert_ne "$(jq -r '.[0].updated_at' <<<"$c2")" "$(jq -r '.[0].updated_at' <<<"$c1")" "it was updated"
  body=$(jq -r '.[0].body' "$RUN_DIR/runs/pr-comment-2.json")
  assert_match "$body" 'Items|shukkatest-items' "the comment names the replaced table"
  assert_match "$body" 'stop' "the comment says the merge will stop"
  assert_eq "$(run_conclusion "$run")" success "the pull-request check stays green for a destructive diff"
  assert_eq "$(table_status shukkatest-items-pr)" ABSENT "nothing from the pull request was deployed"
}
