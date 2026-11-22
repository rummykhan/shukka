# shellcheck shell=bash
# phase: E
# title: a merge that changes only docs
# needs: A
# critical: no

phase_E() {
  local sha id
  snapshot before_docs
  printf '\nDocs-only edit by run %s.\n' "$RUN_ID" >>"$RUN_DIR/consumer/README.md"
  sha=$(commit_all "shukkatest $RUN_ID: docs only") || return 1
  push_main || return 1
  state_set docs_sha "$sha"
  id=$(wait_run_of "$sha") && state_set docs_run "$id"
  snapshot after_docs
}
