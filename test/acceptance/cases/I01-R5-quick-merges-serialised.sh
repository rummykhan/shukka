# shellcheck shell=bash
# case: R5-quick-merges-serialised
# phase: I
# covers: R5.3
# title: two merges in quick succession both deploy, one after the other, and the later commit ends up live

case_run() {
  local a b ja jb re
  a=$(need_state serial_run_a) || return
  b=$(need_state serial_run_b) || return
  re="($JOB_RE_APP).*web|web.*($JOB_RE_APP)"
  assert_eq "$(run_conclusion "$a")" success "the first run is green"
  assert_eq "$(run_conclusion "$b")" success "the second run is green"
  assert_cmd "the first run deployed web" ran_successfully "$a" "$re"
  assert_cmd "the second run deployed web" ran_successfully "$b" "$re"
  ja=$(run_jobs "$a" | jq -r --arg re "$re" '[.[] | select(.name | test($re; "i"))] | first | .completedAt')
  jb=$(run_jobs "$b" | jq -r --arg re "$re" '[.[] | select(.name | test($re; "i"))] | first | .startedAt')
  if [[ -n "$ja" && -n "$jb" && ! "$jb" < "$ja" ]]; then
    ok "the second web deploy started ($jb) after the first finished ($ja)"
  else
    fail "the web deploys overlapped (first finished $ja, second started $jb)"
  fi
  assert_eq "$(need_state after_serial_web_rev)" "$(need_state serial_sha_b)" "the later commit is live"
}
