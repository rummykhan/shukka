# shellcheck shell=bash
# case: R4-pr-diff-comment
# phase: B
# covers: R4.3 SC2
# task: shu-9bj.3
# title: a pull request that changes infrastructure gets the diff as one marked comment

case_run() {
  local run f
  run=$(need_state pr_run1) || return
  f="$RUN_DIR/runs/pr-comment-1.json"
  assert_cmd "a diff job ran and succeeded" ran_successfully "$run" "$JOB_RE_DIFF"
  # Since shu-9zr the comment is posted by its own job (no credentials, no project code).
  assert_cmd "the comment job ran and succeeded" ran_successfully "$run" "$JOB_RE_COMMENT"
  assert_eq "$(jq length "$f")" 1 "exactly one comment carries <!-- shukka:diff -->"
  assert_match "$(jq -r '.[0].body' "$f")" 'Shukkatest-Box' "the comment shows the diff of Shukkatest-Box"
  assert_match "$(jq -r '.[0].body' "$f")" 'Note' "the comment shows the added output"
}
