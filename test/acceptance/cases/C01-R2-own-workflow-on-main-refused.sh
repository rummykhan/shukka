# shellcheck shell=bash
# case: R2-own-workflow-on-main-refused
# phase: C
# covers: R2.2 SC3
# task: shu-9bj.3
# title: a job on main that is not shukka's infra.yml or ec2.yml is refused every deploy role, shukka's and the CDK roles

case_run() {
  local run log claims r
  run=$(need_state main_probe_run) || return
  log=$(run_log "$run")
  claims=$(grep -Eo 'CLAIMS R2-main-own-workflow .*' "$log" | head -n 1)
  assert_match "$claims" '"ref":"refs/heads/main"' "the probe ran on main (the subject condition is met)"
  assert_match "$claims" 'shukka-consumer-test/\.github/workflows/shukkatest-probe\.yml' "its job_workflow_ref is the consumer's own workflow"
  # shukka's roles, and the CDK roles a GitHub token must never reach directly (shu-9bj.3).
  for r in infra app diff cdk-deploy cdk-lookup default-deploy default-lookup; do
    expect_observation "$log" "R2-main-own-workflow-$r" DENIED "$run"
  done
}
