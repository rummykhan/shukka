# shellcheck shell=bash
# case: R5-quick-merges-serialised
# phase: I
# covers: R5.3
# title: two merges in quick succession both deploy, one after the other on the box, and the later commit ends up live

case_run() {
  local a b re aw bw bu a_end b_end
  a=$(need_state serial_run_a) || return
  b=$(need_state serial_run_b) || return
  re="($JOB_RE_APP).*web|web.*($JOB_RE_APP)"
  assert_eq "$(run_conclusion "$a")" success "the first run is green"
  assert_eq "$(run_conclusion "$b")" success "the second run is green"
  assert_cmd "the first run deployed web (not cancelled as a pending duplicate)" ran_successfully "$a" "$re"
  assert_cmd "the second run deployed web" ran_successfully "$b" "$re"
  # Timing from the box, not from job start times: A's release command (SSM's record) ended before
  # B's release was unpacked, and before B's release command ended.
  aw=$(state_get serial_a_window)
  bw=$(state_get serial_b_window)
  bu=$(state_get serial_b_unpacked)
  a_end=${aw#* }
  b_end=${bw#* }
  if [[ "$a_end" =~ ^[0-9]+$ && "$bu" =~ ^[0-9]+$ ]]; then
    if ((bu >= a_end)); then ok "B's release was unpacked ($bu) after A's release finished ($a_end)"
    else fail "B's release was unpacked ($bu) before A's release finished ($a_end): the releases interleaved"; fi
  else
    fail "no box timing for the two releases (A command '$aw', B unpacked '$bu')"
  fi
  if [[ "$a_end" =~ ^[0-9]+$ && "$b_end" =~ ^[0-9]+$ ]] && ((b_end >= a_end)); then ok "B's release command finished after A's"
  else fail "release command order unclear (A '$aw', B '$bw')"; fi
  assert_eq "$(need_state after_serial_web_rev)" "$(need_state serial_sha_b)" "the later commit is live"
}
