# shellcheck shell=bash
# case: R2-infra-yml-refused-off-main
# phase: B
# covers: R2.1
# title: shukka's own infra.yml in deploy mode, called from a branch, a tag or a pull request, is refused the infra role

case_run() {
  local kind run log concl verdict
  for kind in branch tag pr; do
    run=$(need_state "probe_infra_${kind}_run") || continue
    log=$(run_log "$run")
    concl=$(run_conclusion "$run")
    if [[ "$concl" == success ]]; then
      verdict=ALLOWED
    elif grep -Eq 'Not authorized to perform sts:AssumeRoleWithWebIdentity|AccessDenied' "$log"; then
      verdict=DENIED
    else
      verdict=ERROR
    fi
    result "R2-$kind-via-infra-yml" "$verdict" "(run $run, $concl)"
    assert_eq "$verdict" DENIED "infra.yml from a $kind is refused at assume-role"
  done
  assert_eq "$(need_state after_pr_box_updated)" "$(need_state before_pr_box_updated)" "no stack was changed by those runs"
}
