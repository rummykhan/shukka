# shellcheck shell=bash
# case: SC9-no-throwaway-resources-left
# phase: T
# covers: SC9
# title: after teardown nothing tagged Project=shukkatest (or named shukkatest*) is left in the account

case_run() {
  local left
  left=$(leftovers)
  if [[ -z "$left" ]]; then ok "no throwaway resources remain"; else fail "left behind: $(tr '\n' ';' <<<"$left")"; fi
}
