# shellcheck shell=bash
# phase: D
# title: a merge's own CDK code looks for credentials during synth; the execution role is asked to change the stand-in project; the box role reads Trendigle
# needs: A
# critical: no

# The CDK code runs escape.sh while shukka synthesizes it on main (no token, no credentials since
# shu-9zr), and adds Shukkatest-Escape, which the pipeline's deploy hands to shukkatest's execution
# role. What the infra and deploy roles themselves may do is read from IAM by the cases (simulator).
# The restore merge (and the removal of Shukkatest-Escape) runs whatever happened to the escape
# attempt: d_escape runs in its own subshell, so even a die there cannot skip it. A Shukkatest-Escape
# left in the app makes every later deploy fail on the (correct) DeleteStack deny.
phase_D() {
  local rc=0
  (d_escape) || rc=1
  d_restore || rc=1
  return $rc
}

d_escape() {
  local sha id
  snapshot before_escape
  : >"$RUN_DIR/consumer/infra/probe.on"
  json_edit infra/settings.json '.escape = true'
  sha=$(commit_all "shukkatest $RUN_ID: escape attempt (fence check)") || return 1
  push_main || return 1
  state_set escape_sha "$sha"
  id=$(wait_run_of "$sha") && state_set escape_run "$id"
  state_set escape_stack_status "$(stack_status Shukkatest-Escape)"
  aws cloudformation describe-stack-events --stack-name Shukkatest-Escape \
    --query "StackEvents[?contains(ResourceStatus, 'FAILED')].[LogicalResourceId, ResourceStatusReason]" \
    --output text >"$RUN_DIR/runs/escape-events.txt" 2>/dev/null || true
  state_set standin_after_escape "$(stack_last_updated "$(state_get standin_stack)")"
  state_set standin_status_after_escape "$(stack_status "$(state_get standin_stack)")"
  # The CLI's error output starts with a newline and may run to several lines: kept as one line.
  state_set standin_bucket_policy "$(aws s3api get-bucket-policy --bucket "$(state_get standin_bucket)" --query Policy --output text 2>&1 | one_line | head -c 200)"
  state_set standin_queue "$(aws sqs get-queue-url --queue-name "$(state_get standin_table)-queue" --query QueueUrl --output text 2>&1 | one_line | head -c 200)"

  # The instance role (bounded) asked to read Trendigle from the box itself.
  local tt tb
  tt=$(state_get trendigle_table)
  tb=$(state_get trendigle_bucket)
  box_run "aws dynamodb describe-table --region $AWS_REGION --table-name $tt --query Table.TableStatus --output text 2>&1 | head -c 300; echo; aws s3api list-objects-v2 --region $AWS_REGION --bucket $tb --max-keys 1 --query KeyCount --output text 2>&1 | head -c 300" \
    >"$RUN_DIR/runs/box-trendigle-read.txt" || true
}

# d_restore: takes the escape attempt out of the consumer's main (committing and pushing only what is
# needed: nothing if the attempt never reached the working copy), waits for that merge's run, then
# deletes Shukkatest-Escape if it is still there.
d_restore() {
  local sha id rc=0
  rm -f "$RUN_DIR/consumer/infra/probe.on"
  json_edit infra/settings.json '.escape = false' || rc=1
  if [[ -n "$(c_git status --porcelain)" ]]; then
    commit_all "shukkatest $RUN_ID: remove the escape attempt" >/dev/null || rc=1
  fi
  if [[ "$(c_git rev-list --count origin/main..HEAD 2>/dev/null)" != 0 ]]; then
    sha=$(c_git rev-parse HEAD)
    if push_main; then
      if id=$(wait_run_of "$sha"); then state_set escape_restore_run "$id"; else rc=1; fi
    else
      rc=1
    fi
  fi
  if [[ "$(stack_status Shukkatest-Escape)" != ABSENT ]]; then delete_stack Shukkatest-Escape || true; fi
  return $rc
}
