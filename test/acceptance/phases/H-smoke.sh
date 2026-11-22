# shellcheck shell=bash
# phase: H
# title: a healthy release whose smoke test fails, then the fix
# needs: A
# critical: no

phase_H() {
  local sha id
  printf 'this page lost its marker (run %s)\n' "$RUN_ID" >"$RUN_DIR/consumer/apps/web/page.txt"
  sha=$(commit_all "shukkatest $RUN_ID: web page without the smoke marker") || return 1
  push_main || return 1
  state_set smoke_sha "$sha"
  id=$(wait_run_of "$sha") && state_set smoke_run "$id"
  snapshot after_smoke_fail

  printf 'shukkatest-web-ok\n' >"$RUN_DIR/consumer/apps/web/page.txt"
  sha=$(commit_all "shukkatest $RUN_ID: web page marker back") || return 1
  push_main || return 1
  id=$(wait_run_of "$sha") && state_set smoke_restore_run "$id"
}
