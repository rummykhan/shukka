# shellcheck shell=bash
# case: R1-pinned-to-rc-tag
# phase: A
# covers: R1.2
# title: the run used exactly the pinned shukka tag's commit for every shukka workflow it called

case_run() {
  local run rc_sha refs n bad
  run=$(need_state baseline_run) || return
  rc_sha=$(need_state rc_sha) || return
  refs=$(gh api "repos/$CONSUMER_REPO/actions/runs/$run" --jq '.referenced_workflows')
  printf '%s\n' "$refs" >"$RUN_DIR/runs/$run.referenced.json"
  n=$(jq 'length' <<<"$refs")
  if ((n >= 1)); then ok "the run references $n shukka workflow(s)"; else fail "the run references no reusable workflows"; fi
  assert_match "$(jq -r '.[].path' <<<"$refs")" 'rummykhan/shukka/\.github/workflows/pipeline\.yml' "pipeline.yml is among them"
  bad=$(jq -r --arg sha "$rc_sha" '[.[] | select(.sha != $sha or (.path | startswith("rummykhan/shukka/") | not))] | length' <<<"$refs")
  assert_eq "$bad" 0 "every referenced workflow is rummykhan/shukka at $RC_TAG (${rc_sha:0:12})"
  bad=$(jq -r --arg t "$RC_TAG" '[.[] | select(.ref != $t and .ref != ("refs/tags/" + $t))] | length' <<<"$refs")
  assert_eq "$bad" 0 "every referenced workflow resolved through the ref $RC_TAG"
}
