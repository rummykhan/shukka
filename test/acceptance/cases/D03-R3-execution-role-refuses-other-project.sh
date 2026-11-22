# shellcheck shell=bash
# case: R3-execution-role-refuses-other-project
# phase: D
# covers: R3.1
# title: a merged stack that changes the stand-in project is refused by shukkatest's execution role; the run is red and the stand-in unchanged

case_run() {
  local run restore
  run=$(need_state escape_run) || return
  restore=$(need_state escape_restore_run) || return
  assert_eq "$(run_conclusion "$run")" failure "the merge with the escape stack is red"
  assert_match "$(need_state escape_stack_status)" 'ROLLBACK|FAILED' "Shukkatest-Escape did not deploy"
  assert_match "$(cat "$RUN_DIR/runs/escape-events.txt" 2>/dev/null)" 'not authorized|AccessDenied' \
    "CloudFormation reports an authorisation failure"
  assert_match "$(need_state standin_bucket_policy)" 'NoSuchBucketPolicy' "the stand-in bucket has no policy"
  assert_match "$(need_state standin_queue)" 'NonExistentQueue|does not exist' "no queue was created in the stand-in's name space"
  assert_eq "$(run_conclusion "$restore")" success "the next merge, without the escape stack, is green again"
}
