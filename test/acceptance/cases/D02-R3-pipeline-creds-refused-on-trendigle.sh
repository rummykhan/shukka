# shellcheck shell=bash
# case: R3-pipeline-creds-refused-on-trendigle
# phase: D
# covers: R3.1 SC4
# title: shukkatest's pipeline credentials are refused on a Trendigle table and bucket (read-only attempts)

case_run() {
  local run log p o
  run=$(need_state escape_run) || return
  log=$(run_log "$run")
  for p in R3-pipeline-infra R3-pipeline-deployrole; do
    for o in trendigle-table-read trendigle-bucket-read; do
      expect_observation "$log" "$p-$o" DENIED "$run"
    done
  done
}
