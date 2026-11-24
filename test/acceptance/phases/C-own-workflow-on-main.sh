# shellcheck shell=bash
# phase: C
# title: the consumer's own workflow on main asks for the deploy roles
# needs: A
# critical: no

phase_C() {
  local sha id
  c_git checkout -q main || return 1
  cp -f "$RUN_DIR/consumer/probe/workflows/shukkatest-probe.yml" "$RUN_DIR/consumer/.github/workflows/"
  sha=$(commit_all "shukkatest $RUN_ID: probe workflow on main (removed in the next commit)") || return 1
  enable_probe_workflows || return 1
  push_main || return 1
  state_set main_probe_sha "$sha"
  id=$(wait_run_of "$sha" "$PROBE_WORKFLOW" push main) && state_set main_probe_run "$id"
  wait_run_of "$sha" >/dev/null || true
  rm -f "$RUN_DIR/consumer/.github/workflows/shukkatest-probe.yml"
  sha=$(commit_all "shukkatest $RUN_ID: remove the probe workflow from main") || return 1
  push_main || return 1
  wait_run_of "$sha" >/dev/null || true
}
