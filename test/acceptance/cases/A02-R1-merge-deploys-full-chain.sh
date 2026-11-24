# shellcheck shell=bash
# case: R1-merge-deploys-full-chain
# phase: A
# covers: R1.1 SC1 R3.2
# title: the first merge to main runs checks, infrastructure deploy, app deploy for both apps and smoke, green

case_run() {
  local run sha app
  run=$(need_state baseline_run) || return
  sha=$(need_state baseline_sha) || return
  assert_eq "$(run_conclusion "$run")" success "the merge run is green"
  assert_cmd "a plan job ran and succeeded" ran_successfully "$run" "$JOB_RE_PLAN"
  assert_cmd "a checks job ran and succeeded" ran_successfully "$run" "$JOB_RE_CHECKS"
  assert_cmd "a build job ran and succeeded" ran_successfully "$run" "$JOB_RE_BUILD"
  assert_cmd "an infrastructure deploy job ran and succeeded" infra_deploy_succeeded "$run"
  for app in web api; do
    assert_cmd "the app deploy job for $app ran and succeeded" ran_successfully "$run" "($JOB_RE_APP).*$app|$app.*($JOB_RE_APP)"
  done
  assert_cmd "a smoke job ran and succeeded" ran_successfully "$run" "$JOB_RE_SMOKE"
  assert_match "$(stack_status Shukkatest-Box)" '^(CREATE|UPDATE)_COMPLETE$' "Shukkatest-Box is deployed"
  assert_eq "$(stack_tag Shukkatest-Box shukka:revision)" "$sha" "Shukkatest-Box carries shukka:revision = the merged commit"
}
