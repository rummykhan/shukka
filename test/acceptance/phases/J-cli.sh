# shellcheck shell=bash
# phase: J
# title: emergency deploys from this machine with the CLI while the caller workflow is disabled
# needs: A
# critical: no

# cli_try <label>: runs `shukka deploy` in the consumer clone, keeps its output and exit code.
cli_try() {
  local label=$1 rc
  shift
  SHUKKATEST_GREETING=$(state_get greeting) cli_deploy "$RUN_DIR/consumer" "$@" >"$RUN_DIR/runs/cli-$label.log" 2>&1
  rc=$?
  state_set "cli_${label}_rc" "$rc"
  log "shukka deploy ($label) exited $rc"
}

phase_J() {
  local sha
  c_git checkout -q main || return 1
  gh workflow disable "$CALLER_WORKFLOW" -R "$CONSUMER_REPO" || return 1
  state_set workflow_disabled 1

  # 1. A merged change deployed from the laptop.
  snapshot before_cli
  printf 'shukkatest-web-ok\nemergency deploy %s\n' "$RUN_ID" >"$RUN_DIR/consumer/apps/web/page.txt"
  sha=$(commit_all "shukkatest $RUN_ID: change deployed by the CLI") || return 1
  push_main || return 1
  state_set cli_sha "$sha"
  cli_try deploy
  state_set cli_runs_for_sha "$(runs_for_sha_count "$sha")"
  snapshot after_cli

  # 2. Refusals: a dirty tree, and a commit that is not on origin/main.
  printf 'dirty\n' >>"$RUN_DIR/consumer/README.md"
  cli_try dirty
  c_git checkout -q -- README.md
  printf '\nlocal only\n' >>"$RUN_DIR/consumer/README.md"
  commit_all "shukkatest $RUN_ID: local commit, not pushed" >/dev/null
  cli_try ahead
  c_git reset -q --hard origin/main

  # 3. The same guard: a table replacement stops the deploy.
  snapshot before_cli_guard
  json_edit infra/settings.json '.tableName = "shukkatest-items-v3"'
  sha=$(commit_all "shukkatest $RUN_ID: CLI destructive change") || return 1
  push_main || return 1
  state_set cli_guard_sha "$sha"
  cli_try guard
  snapshot after_cli_guard
  state_set cli_guard_new_table "$(table_status shukkatest-items-v3)"
  json_edit infra/settings.json '.tableName = "shukkatest-items-v2"'
  commit_all "shukkatest $RUN_ID: undo the CLI destructive change" >/dev/null && push_main

  # 4. The same rollback: an unhealthy release from the laptop.
  snapshot before_cli_unhealthy
  printf '{ "healthy": false }\n' >"$RUN_DIR/consumer/apps/web/health.json"
  sha=$(commit_all "shukkatest $RUN_ID: CLI unhealthy release") || return 1
  push_main || return 1
  state_set cli_unhealthy_sha "$sha"
  cli_try unhealthy
  snapshot after_cli_unhealthy
  printf '{ "healthy": true }\n' >"$RUN_DIR/consumer/apps/web/health.json"
  sha=$(commit_all "shukkatest $RUN_ID: CLI healthy again") || return 1
  push_main || return 1
  cli_try restore

  enable_workflow "$CALLER_WORKFLOW" && state_set workflow_disabled 0
}
