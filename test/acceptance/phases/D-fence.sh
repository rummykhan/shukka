# shellcheck shell=bash
# phase: D
# title: the pipeline's credentials and execution role try to change the stand-in project and read Trendigle
# needs: A
# critical: no

phase_D() {
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
  state_set standin_bucket_policy "$(aws s3api get-bucket-policy --bucket "$(state_get standin_bucket)" --query Policy --output text 2>&1 | head -c 200)"
  state_set standin_queue "$(aws sqs get-queue-url --queue-name "$(state_get standin_table)-queue" --query QueueUrl --output text 2>&1 | head -c 200)"

  # The instance role (bounded) asked to read Trendigle from the box itself.
  local tt tb
  tt=$(state_get trendigle_table)
  tb=$(state_get trendigle_bucket)
  box_run "aws dynamodb describe-table --region $AWS_REGION --table-name $tt --query Table.TableStatus --output text 2>&1 | head -c 300; echo; aws s3api list-objects-v2 --region $AWS_REGION --bucket $tb --max-keys 1 --query KeyCount --output text 2>&1 | head -c 300" \
    >"$RUN_DIR/runs/box-trendigle-read.txt" || true

  rm -f "$RUN_DIR/consumer/infra/probe.on"
  json_edit infra/settings.json '.escape = false'
  sha=$(commit_all "shukkatest $RUN_ID: remove the escape attempt") || return 1
  push_main || return 1
  id=$(wait_run_of "$sha") && state_set escape_restore_run "$id"
  if [[ "$(stack_status Shukkatest-Escape)" != ABSENT ]]; then delete_stack Shukkatest-Escape || true; fi
}
