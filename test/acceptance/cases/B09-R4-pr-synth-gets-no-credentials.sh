# shellcheck shell=bash
# case: R4-pr-synth-gets-no-credentials
# phase: B
# covers: R4.3 SC2 R2.1
# task: shu-9bj.3
# title: the pull request's own CDK code, run by shukka's synth, finds no OIDC token endpoint, no AWS credentials and no GitHub token

# The probe (infra/probe.on) runs escape.sh inside the CDK app. Only the lines the pull-request synth
# job printed count, so a probe that ran elsewhere (or not at all: MISSING) cannot pass.
case_run() {
  local run f
  run=$(need_state pr_run1) || return
  assert_cmd "the pull request's synth job ran and succeeded" ran_successfully "$run" "$JOB_RE_PR_SYNTH"
  f=$(job_messages_file "$run" "$JOB_RE_PR_SYNTH" pr-synth)
  assert_match "$(cat "$f")" '^PROBE escape running in .*pull_request' "the probe ran inside the pull request's synth"
  expect_observation "$f" R4-pr-synth-oidc NO-TOKEN "$run"
  expect_observation "$f" R4-pr-synth-aws NO-CREDS "$run"
  expect_observation "$f" R4-pr-synth-github-token NO-TOKEN "$run"
}
