# shellcheck shell=bash
# phase: I
# title: two merges in quick succession
# needs: A
# critical: no

phase_I() {
  local a b ida idb
  printf 'shukkatest-web-ok\nquick merge A %s\n' "$RUN_ID" >"$RUN_DIR/consumer/apps/web/page.txt"
  a=$(commit_all "shukkatest $RUN_ID: quick merge A") || return 1
  push_main || return 1
  ida=$(wait_run_for_sha "$a" "$CALLER_WORKFLOW" push) || return 1
  printf 'shukkatest-web-ok\nquick merge B %s\n' "$RUN_ID" >"$RUN_DIR/consumer/apps/web/page.txt"
  b=$(commit_all "shukkatest $RUN_ID: quick merge B") || return 1
  push_main || return 1
  state_set serial_sha_a "$a"
  state_set serial_sha_b "$b"
  state_set serial_run_a "$ida"
  idb=$(wait_run_for_sha "$b" "$CALLER_WORKFLOW" push) || return 1
  state_set serial_run_b "$idb"
  wait_run_done "$ida" >/dev/null || true
  wait_run_done "$idb" >/dev/null || true
  snapshot after_serial
}
