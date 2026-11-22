# shellcheck shell=bash
# phase: B
# title: a pull request (app and harmless infra change, then a destructive one) carrying the trust probes
# needs: A
# critical: no

phase_B() {
  local branch="shukkatest-probe-$RUN_ID" tag="shukkatest-probe-tag-$RUN_ID" sha1 sha2 pr id
  require_consumer_remote || return 1
  snapshot before_pr
  c_git checkout -q -B "$branch" main || return 1
  # An app change that keeps the smoke marker, a harmless infra change (a new output), the probe
  # workflows, and the escape probe inside the CDK app (it runs in the pull request's synth job, which
  # must hold no token and no credentials).
  printf 'shukkatest-web-ok\npull request %s\n' "$RUN_ID" >"$RUN_DIR/consumer/apps/web/page.txt"
  # shellcheck disable=SC2016 # a jq program
  json_edit infra/settings.json --arg n "pr-$RUN_ID" '.note = $n'
  cp -f "$RUN_DIR/consumer/probe/workflows/"*.yml "$RUN_DIR/consumer/.github/workflows/"
  : >"$RUN_DIR/consumer/infra/probe.on"
  sha1=$(commit_all "shukkatest $RUN_ID: pull request with probes") || return 1
  state_set pr_branch "$branch"
  state_set pr_tag "$tag"
  state_set pr_sha1 "$sha1"
  c_git push -q origin "$branch" || return 1
  c_git tag "$tag" && c_git push -q origin "refs/tags/$tag" || return 1
  gh pr create -R "$CONSUMER_REPO" --head "$branch" --base main \
    --title "shukkatest $RUN_ID: probes (closed by the suite)" \
    --body "Opened by shukka's acceptance suite; closed and deleted at the end of the run." >/dev/null || return 1
  pr=$(gh pr view "$branch" -R "$CONSUMER_REPO" --json number -q .number) || return 1
  state_set pr_number "$pr"

  id=$(wait_run_of "$sha1" "$CALLER_WORKFLOW" pull_request) && state_set pr_run1 "$id"
  id=$(wait_run_of "$sha1" "$PROBE_WORKFLOW" pull_request) && state_set probe_pr_run "$id"
  id=$(wait_run_of "$sha1" "$PROBE_WORKFLOW" push "$branch") && state_set probe_branch_run "$id"
  id=$(wait_run_of "$sha1" "$PROBE_WORKFLOW" push "$tag") && state_set probe_tag_run "$id"
  id=$(wait_run_of "$sha1" "$PROBE_WORKFLOW-infra" pull_request) && state_set probe_infra_pr_run "$id"
  id=$(wait_run_of "$sha1" "$PROBE_WORKFLOW-infra" push "$branch") && state_set probe_infra_branch_run "$id"
  id=$(wait_run_of "$sha1" "$PROBE_WORKFLOW-infra" push "$tag") && state_set probe_infra_tag_run "$id"
  state_set pr_comments1 "$(pr_diff_comments "$pr" | jq -c 'map({id, updated_at})')"
  pr_diff_comments "$pr" >"$RUN_DIR/runs/pr-comment-1.json"

  # Second push: the same pull request now replaces the table (a destructive diff).
  json_edit infra/settings.json '.tableName = "shukkatest-items-pr"'
  sha2=$(commit_all "shukkatest $RUN_ID: pull request replaces the table") || return 1
  state_set pr_sha2 "$sha2"
  c_git push -q origin "$branch" || return 1
  id=$(wait_run_of "$sha2" "$CALLER_WORKFLOW" pull_request) && state_set pr_run2 "$id"
  state_set pr_comments2 "$(pr_diff_comments "$pr" | jq -c 'map({id, updated_at})')"
  pr_diff_comments "$pr" >"$RUN_DIR/runs/pr-comment-2.json"
  snapshot after_pr

  gh pr close "$pr" -R "$CONSUMER_REPO" --delete-branch >/dev/null 2>&1 || true
  gh api -X DELETE "repos/$CONSUMER_REPO/git/refs/tags/$tag" >/dev/null 2>&1 || true
  c_git checkout -q main
}
