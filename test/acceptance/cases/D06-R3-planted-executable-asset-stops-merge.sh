# shellcheck shell=bash
# case: R3-planted-executable-asset-stops-merge
# phase: D2
# covers: R3.1 R2.2 R4.3
# task: shu-9bj.3
# title: a merge whose CDK code plants an asset built by a command is refused at the deploy job's assembly check; nothing deploys and the command never runs

case_run() {
  local run restore msgs
  run=$(need_state planted_run) || return
  restore=$(need_state planted_restore_run) || return
  msgs=$(job_messages "$run" "$JOB_RE_INFRA")
  assert_eq "$(run_conclusion "$run")" failure "the merge run is red"
  assert_cmd "the synth job (no credentials) succeeded: the refusal comes later" ran_successfully "$run" "$JOB_RE_INFRA_SYNTH"
  assert_eq "$(infra_deploy_conclusions "$run")" failure "the infrastructure deploy job stopped"
  if grep -Eq '^assembly: .*file asset shukkatestplantedasset is built by running a command \(source\.executable\); refused' <<<"$msgs"; then
    ok "the assembly check named the planted asset and refused it"
  else
    fail "no line '^assembly: ... shukkatestplantedasset ... (source.executable); refused' in the deploy job"
  fi
  assert_no_match "$(cat "$(run_log "$run")")" 'SHUKKATEST-PLANTED-ASSET-RAN-42' "the planted command never ran"
  assert_no_match "$msgs" '^shukka: infrastructure deployed' "cdk deploy did not run"
  assert_cmd "no app deploy job ran" did_not_run "$run" "$JOB_RE_APP"
  assert_eq "$(need_state after_planted_box_updated)" "$(need_state before_planted_box_updated)" "Shukkatest-Box was not updated"
  assert_eq "$(need_state after_planted_box_revision)" "$(need_state before_planted_box_revision)" "Shukkatest-Box's revision tag is unchanged"
  assert_eq "$(run_conclusion "$restore")" success "the next merge, without the planted asset, is green again"
}
