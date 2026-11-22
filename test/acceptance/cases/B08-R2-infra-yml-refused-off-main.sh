# shellcheck shell=bash
# case: R2-infra-yml-refused-off-main
# phase: B
# covers: R2.1
# task: shu-9bj.3
# title: shukka's own infra.yml in deploy mode, called from a branch, a tag or a pull request, is refused the infra role in its changes job, and its deploy job never runs

# Since shu-9zr infra.yml first runs synth (no id-token), then the changes job asks for the infra role.
# Only the changes job's own lines count (the synth job's probe prints its own verdicts).
case_run() {
  local kind run concl msgs verdict
  for kind in branch tag pr; do
    run=$(need_state "probe_infra_${kind}_run") || continue
    concl=$(run_conclusion "$run")
    msgs=$(job_messages "$run" '/ changes$|^changes$')
    if [[ "$concl" == success ]]; then
      verdict=ALLOWED
    elif grep -Eq 'Not authorized to perform sts:AssumeRoleWithWebIdentity|AccessDenied' <<<"$msgs"; then
      verdict=DENIED
    else
      verdict=ERROR
    fi
    result "R2-$kind-via-infra-yml" "$verdict" "(run $run, $concl)"
    assert_eq "$verdict" DENIED "infra.yml from a $kind is refused at assume-role in its changes job"
    assert_cmd "infra.yml's deploy job did not run from a $kind" did_not_run "$run" '/ deploy$|^deploy$'
  done
  assert_eq "$(need_state after_pr_box_updated)" "$(need_state before_pr_box_updated)" "no stack was changed by those runs"
}
