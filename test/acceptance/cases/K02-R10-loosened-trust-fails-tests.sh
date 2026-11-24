# shellcheck shell=bash
# case: R10-loosened-trust-fails-tests
# phase: K
# covers: R10.1
# title: loosening any trust condition in the construct source (branch, pull_request subject, workflow, audience) makes shukka's tests fail

case_run() {
  local r name rc x
  assert_eq "$(need_state k_control_rc)" 0 "the unmodified release candidate's tests pass"
  r=$(state_get k_trust_results)
  [[ -n "$r" ]] || { fail "no trust condition was found to loosen in lib/ (nothing tested)"; return; }
  for x in $r; do
    name=${x%:*}
    rc=${x##*:}
    if [[ "$rc" != 0 ]]; then ok "tests fail when '$name' is loosened"; else fail "tests still pass when '$name' is loosened"; fi
  done
}
