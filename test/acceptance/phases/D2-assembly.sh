# shellcheck shell=bash
# phase: D2
# title: a merge whose CDK code plants an executable asset in the cloud assembly stops at the assembly check
# needs: A
# critical: no

# shu-9bj.3. The project's CDK code (settings.plantExecutableAsset) adds a file asset that cdk-assets
# would build by running a command on the deploy runner, where the deploy role is held. shukka's deploy
# job must refuse the assembly before it assumes a role; nothing is deployed and the command never runs.
phase_D2() {
  local sha id
  c_git checkout -q main || return 1
  snapshot before_planted
  json_edit infra/settings.json '.plantExecutableAsset = true'
  sha=$(commit_all "shukkatest $RUN_ID: CDK code plants an executable asset (assembly check)") || return 1
  push_main || return 1
  state_set planted_sha "$sha"
  id=$(wait_run_of "$sha") && state_set planted_run "$id"
  snapshot after_planted

  json_edit infra/settings.json '.plantExecutableAsset = false'
  sha=$(commit_all "shukkatest $RUN_ID: remove the planted asset") || return 1
  push_main || return 1
  id=$(wait_run_of "$sha") && state_set planted_restore_run "$id"
}
