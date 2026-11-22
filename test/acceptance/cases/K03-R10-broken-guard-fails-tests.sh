# shellcheck shell=bash
# case: R10-broken-guard-fails-tests
# phase: K
# covers: R10.1
# title: a guard that always says "safe" when run as a command makes shukka's tests fail

case_run() {
  assert_eq "$(need_state k_control_rc)" 0 "the unmodified release candidate's tests pass"
  assert_ne "$(need_state k_guard_rc)" 0 "the tests fail against the broken guard"
}
