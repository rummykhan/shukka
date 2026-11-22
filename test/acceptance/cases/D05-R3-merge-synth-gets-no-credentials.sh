# shellcheck shell=bash
# case: R3-merge-synth-gets-no-credentials
# phase: D
# covers: R3.1 R2.2 SC3
# task: shu-9bj.3
# title: on a merge to main the project's own CDK code, run by shukka's synth, finds no OIDC token endpoint, no AWS credentials and no GitHub token

# The escape merge carries the probe (infra/probe.on). Only the lines the stacks' synth job printed
# count; a probe that did not run there is MISSING and fails.
case_run() {
  local run f
  run=$(need_state escape_run) || return
  assert_cmd "the merge's synth job ran and succeeded" ran_successfully "$run" "$JOB_RE_INFRA_SYNTH"
  f=$(job_messages_file "$run" "$JOB_RE_INFRA_SYNTH" merge-synth)
  assert_match "$(cat "$f")" '^PROBE escape running in .*push refs/heads/main' "the probe ran inside the merge's synth"
  expect_observation "$f" R3-merge-synth-oidc NO-TOKEN "$run"
  expect_observation "$f" R3-merge-synth-aws NO-CREDS "$run"
  expect_observation "$f" R3-merge-synth-github-token NO-TOKEN "$run"
}
