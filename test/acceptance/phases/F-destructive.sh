# shellcheck shell=bash
# phase: F
# title: a merge that replaces the table, then a manual run with allow_replacement
# needs: A
# critical: no

phase_F() {
  local sha id since
  snapshot before_destructive
  json_edit infra/settings.json '.tableName = "shukkatest-items-v2"'
  sha=$(commit_all "shukkatest $RUN_ID: rename the table (replacement)") || return 1
  push_main || return 1
  state_set destructive_sha "$sha"
  id=$(wait_run_of "$sha") && state_set destructive_run "$id"
  snapshot after_destructive
  state_set after_destructive_old_table "$(table_status shukkatest-items)"
  state_set after_destructive_new_table "$(table_status shukkatest-items-v2)"

  since=$(now_iso)
  id=$(dispatch_and_wait "$since" -f allow_replacement=true -f force=false) && state_set allow_run "$id"
  snapshot after_allow
  state_set after_allow_old_table "$(table_status shukkatest-items)"
  state_set after_allow_new_table "$(table_status shukkatest-items-v2)"
}
