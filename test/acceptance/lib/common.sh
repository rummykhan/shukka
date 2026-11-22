# shellcheck shell=bash
# Shared helpers for the shukka acceptance suite (shu-95y). Sourced by run.sh, phases and cases.
#
# Everything this suite creates is named shukkatest* (or standin-shukkatest* for the stand-in "other
# project") and tagged Project=shukkatest. Every delete goes through is_ours(). Trendigle and Orbitary
# resources are only ever read (the refusal checks), never written.

# shellcheck disable=SC2034 # these are read by run.sh, phases and cases
SUITE_TASK=shu-95y
PROJECT=shukkatest
# shellcheck disable=SC2034
QUALIFIER=shukkatest
# shellcheck disable=SC2034
SHUKKA_REPO=${SHUKKATEST_SHUKKA_REPO:-rummykhan/shukka}
CONSUMER_REPO=${SHUKKATEST_CONSUMER_REPO:-rummykhan/shukka-consumer-test}
CALLER_WORKFLOW=${SHUKKATEST_CALLER_WORKFLOW:-CI}          # the caller's `name:`
# shellcheck disable=SC2034
PROBE_WORKFLOW=shukkatest-probe                            # probe workflows' `name:` prefix
export AWS_PROFILE=${AWS_PROFILE:-stelking}
export AWS_REGION=${AWS_REGION:-us-east-1}
export AWS_DEFAULT_REGION=$AWS_REGION
export AWS_PAGER=""
export GH_PAGER=""

# Job display names in the pipeline are not fixed by the design; these patterns (case-insensitive,
# matched against `gh run view --json jobs` names such as "shukka / infra / deploy") are the suite's
# reading of C1. Asked on shu-9zr's mailbox; adjust here only.
JOB_RE_PLAN=${JOB_RE_PLAN:-'plan'}
JOB_RE_CHECKS=${JOB_RE_CHECKS:-'check'}
JOB_RE_BUILD=${JOB_RE_BUILD:-'build'}
JOB_RE_INFRA=${JOB_RE_INFRA:-'infra|deploy'}
JOB_RE_DIFF=${JOB_RE_DIFF:-'diff'}
JOB_RE_APP=${JOB_RE_APP:-'app|ec2|release'}
JOB_RE_SMOKE=${JOB_RE_SMOKE:-'smoke'}

ACCEPT_DIR=${ACCEPT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}

# ---------------------------------------------------------------------------------------------
# Logging and results

log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

# result <observation-id> <DENIED|ALLOWED|ERROR|PASS|FAIL|...> [detail]
# The line the acceptance criteria grep for: "RESULT <case> DENIED".
result() {
  local line
  line="RESULT $1 $2${3:+ $3}"
  printf '%s\n' "$line" >&2
  if [[ -n "${RESULTS_FILE:-}" ]]; then printf '%s\n' "$line" >>"$RESULTS_FILE"; fi
}

# Assertions used inside case_run. They never exit; they count failures in CASE_FAILS.
CASE_FAILS=${CASE_FAILS:-0}
ok() { printf '    ok - %s\n' "$*" >&2; }
fail() { printf '    not ok - %s\n' "$*" >&2; CASE_FAILS=$((CASE_FAILS + 1)); }
assert_eq() { # actual expected description
  if [[ "$1" == "$2" ]]; then ok "$3"; else fail "$3 (got '$1', want '$2')"; fi
}
assert_ne() { # actual unexpected description
  if [[ "$1" != "$2" ]]; then ok "$3"; else fail "$3 (got '$1', which it must not be)"; fi
}
assert_match() { # text extended-regex description
  if grep -Eiq -- "$2" <<<"$1"; then ok "$3"; else fail "$3 (no match for /$2/)"; fi
}
assert_no_match() { # text extended-regex description
  if grep -Eiq -- "$2" <<<"$1"; then fail "$3 (unexpected match for /$2/)"; else ok "$3"; fi
}
assert_cmd() { # description command...
  local d=$1; shift
  if "$@" >/dev/null 2>&1; then ok "$d"; else fail "$d (command failed: $*)"; fi
}
assert_not_cmd() { # description command...
  local d=$1; shift
  if "$@" >/dev/null 2>&1; then fail "$d (command succeeded: $*)"; else ok "$d"; fi
}

# ---------------------------------------------------------------------------------------------
# Run state: key=value lines in $RUN_DIR/state.env; the last value for a key wins.

state_set() {
  [[ "$2" != *$'\n'* ]] || die "state_set $1: value has a newline"
  printf '%s=%s\n' "$1" "$2" >>"$RUN_DIR/state.env"
}
state_get() {
  [[ -f "$RUN_DIR/state.env" ]] || return 0
  grep -E "^$1=" "$RUN_DIR/state.env" | tail -n 1 | cut -d= -f2-
}
need_state() { # key → value, or fail the case
  local v
  v=$(state_get "$1")
  if [[ -z "$v" ]]; then fail "state '$1' is missing (an earlier phase did not record it)"; return 1; fi
  printf '%s\n' "$v"
}

# ---------------------------------------------------------------------------------------------
# Safety: the only names this suite may change or delete.

is_ours() {
  [[ "$1" =~ ^(shukkatest|Shukkatest|cdk-shukkatest-|standin-shukkatest|Standin-shukkatest) ]]
}
require_ours() {
  is_ours "$1" || die "refusing to touch '$1': not a shukkatest resource"
}

# ---------------------------------------------------------------------------------------------
# Polling

# wait_until <timeout-seconds> <interval-seconds> <command...>: retries until the command succeeds.
wait_until() {
  local timeout=$1 interval=$2 start
  shift 2
  start=$(date +%s)
  until "$@"; do
    if (($(date +%s) - start >= timeout)); then return 1; fi
    sleep "$interval"
  done
}

# ---------------------------------------------------------------------------------------------
# GitHub runs in the test consumer

# run_for_sha <sha> <workflow-name> <event> [head-branch-or-tag]: newest matching run id, or nothing.
run_for_sha() {
  gh run list -R "$CONSUMER_REPO" --commit "$1" --limit 50 \
    --json databaseId,workflowName,event,createdAt,headBranch 2>/dev/null |
    jq -r --arg w "$2" --arg e "$3" --arg b "${4:-}" \
      '[.[] | select(.workflowName == $w and .event == $e and ($b == "" or .headBranch == $b))]
       | sort_by(.createdAt) | last | .databaseId // empty'
}

# wait_run_for_sha <sha> <workflow-name> <event> [head-branch-or-tag] [appear-timeout]: echoes the run id.
wait_run_for_sha() {
  local sha=$1 wf=$2 ev=$3 head=${4:-} timeout=${5:-300} start id
  start=$(date +%s)
  while :; do
    id=$(run_for_sha "$sha" "$wf" "$ev" "$head")
    if [[ -n "$id" ]]; then printf '%s\n' "$id"; return 0; fi
    if (($(date +%s) - start >= timeout)); then
      log "no '$wf' run for $ev at ${sha:0:12} after ${timeout}s"
      return 1
    fi
    sleep 10
  done
}

# wait_run_done <run-id> [timeout]: waits for completion, echoes the conclusion.
wait_run_done() {
  local id=$1 timeout=${2:-2700} start status
  start=$(date +%s)
  while :; do
    status=$(gh run view "$id" -R "$CONSUMER_REPO" --json status,conclusion -q '.status + " " + (.conclusion // "")' 2>/dev/null || true)
    if [[ "$status" == completed* ]]; then
      printf '%s\n' "${status#completed }"
      return 0
    fi
    if (($(date +%s) - start >= timeout)); then
      log "run $id still '$status' after ${timeout}s"
      printf 'timeout\n'
      return 1
    fi
    sleep 15
  done
}

# wait_run_of <sha> [workflow] [event] [head]: waits for the run of a pushed commit to finish, echoes its id.
wait_run_of() {
  local sha=$1 wf=${2:-$CALLER_WORKFLOW} ev=${3:-push} head=${4:-} id concl
  id=$(wait_run_for_sha "$sha" "$wf" "$ev" "$head") || return 1
  log "run $id ($wf, $ev${head:+, $head}, ${sha:0:12}): https://github.com/$CONSUMER_REPO/actions/runs/$id"
  concl=$(wait_run_done "$id") || true
  log "run $id finished: $concl"
  printf '%s\n' "$id"
}

# dispatch_and_wait <since-iso8601> -f k=v...: runs the caller by hand on main, waits, echoes the run id.
dispatch_and_wait() {
  local since=$1 id start concl
  shift
  gh workflow run "$CALLER_WORKFLOW" -R "$CONSUMER_REPO" --ref main "$@" >/dev/null || return 1
  start=$(date +%s)
  while :; do
    id=$(gh run list -R "$CONSUMER_REPO" --workflow "$CALLER_WORKFLOW" --event workflow_dispatch --limit 10 \
      --json databaseId,createdAt -q "[.[] | select(.createdAt >= \"$since\")] | sort_by(.createdAt) | last | .databaseId // empty")
    [[ -n "$id" ]] && break
    (($(date +%s) - start < 300)) || { log "no workflow_dispatch run appeared"; return 1; }
    sleep 10
  done
  log "run $id (workflow_dispatch $*): https://github.com/$CONSUMER_REPO/actions/runs/$id"
  concl=$(wait_run_done "$id") || true
  log "run $id finished: $concl"
  printf '%s\n' "$id"
}

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# runs_for_sha_count <sha>: how many runs of any workflow exist for a commit.
runs_for_sha_count() {
  gh run list -R "$CONSUMER_REPO" --commit "$1" --limit 50 --json databaseId -q 'length' 2>/dev/null || printf '0\n'
}

# pr_diff_comments <pr-number>: JSON array of {id, updated_at, body} for comments with the marker.
pr_diff_comments() {
  gh api "repos/$CONSUMER_REPO/issues/$1/comments" --paginate \
    --jq '[.[] | select(.body | contains("<!-- shukka:diff -->")) | {id, updated_at, body}]' 2>/dev/null |
    jq -s 'add // []'
}

run_conclusion() { gh run view "$1" -R "$CONSUMER_REPO" --json conclusion -q .conclusion; }

# run_jobs <run-id>: JSON array of {name, conclusion, startedAt, completedAt}.
run_jobs() {
  local f="$RUN_DIR/runs/$1.jobs.json"
  if [[ ! -s "$f" ]]; then
    mkdir -p "$RUN_DIR/runs"
    gh run view "$1" -R "$CONSUMER_REPO" --json jobs -q '[.jobs[] | {name, conclusion, status, startedAt, completedAt}]' >"$f"
  fi
  cat "$f"
}

# jobs_matching <run-id> <regex>: "name<TAB>conclusion" lines for jobs whose name matches.
jobs_matching() {
  run_jobs "$1" | jq -r --arg re "$2" '.[] | select(.name | test($re; "i")) | "\(.name)\t\(.conclusion)"'
}

# job_conclusions <run-id> <regex>: the distinct conclusions of matching jobs, space-separated, sorted.
job_conclusions() {
  jobs_matching "$1" "$2" | cut -f2 | sort -u | tr '\n' ' ' | sed 's/ $//'
}

# ran_successfully <run-id> <regex>: at least one matching job and all of them succeeded.
ran_successfully() {
  local c
  c=$(job_conclusions "$1" "$2")
  [[ "$c" == "success" ]]
}

# did_not_run <run-id> <regex>: no matching job ran (absent or skipped).
did_not_run() {
  local c
  c=$(job_conclusions "$1" "$2")
  [[ -z "$c" || "$c" == "skipped" ]]
}

# infra_deploy_conclusions <run-id>: distinct conclusions of infrastructure deploy jobs (names that
# match JOB_RE_INFRA but neither JOB_RE_DIFF nor JOB_RE_APP), space-separated.
infra_deploy_conclusions() {
  run_jobs "$1" | jq -r --arg i "$JOB_RE_INFRA" --arg d "$JOB_RE_DIFF" --arg a "$JOB_RE_APP" \
    '[.[] | select((.name | test($i; "i")) and (.name | test($d; "i") | not) and (.name | test($a; "i") | not))
      | .conclusion] | unique | join(" ")'
}
infra_deploy_succeeded() { [[ "$(infra_deploy_conclusions "$1")" == success ]]; }
infra_deploy_not_run() {
  local c
  c=$(infra_deploy_conclusions "$1")
  [[ -z "$c" || "$c" == skipped ]]
}

# run_log <run-id>: path of the full log of a completed run (cached).
run_log() {
  local f="$RUN_DIR/runs/$1.log"
  mkdir -p "$RUN_DIR/runs"
  if [[ ! -s "$f" ]]; then
    wait_until 180 10 gh_fetch_log "$1" "$f" || log "could not fetch the log of run $1"
  fi
  printf '%s\n' "$f"
}
gh_fetch_log() { gh run view "$1" -R "$CONSUMER_REPO" --log >"$2" 2>/dev/null && [[ -s "$2" ]]; }

# observed <log-file> <observation-id>: the verdict a probe printed ("RESULT <id> <VERDICT> ..."), or ERROR.
observed() {
  local v
  v=$(grep -Eo "RESULT $2 [A-Z]+" "$1" | head -n 1 | awk '{print $3}')
  printf '%s\n' "${v:-MISSING}"
}

# expect_observation <log-file> <observation-id> <expected-verdict> <run-id>
# Re-emits the probe's line into the suite log as RESULT <id> <verdict>, and asserts it.
expect_observation() {
  local v detail
  v=$(observed "$1" "$2")
  detail=$(grep -Eo "RESULT $2 [A-Z]+.*" "$1" | head -n 1 | cut -d' ' -f4- | cut -c1-160)
  result "$2" "$v" "(run $4${detail:+: $detail})"
  assert_eq "$v" "$3" "$2 is $3"
}

# ---------------------------------------------------------------------------------------------
# AWS reads used by cases (admin profile, read-only)

stack_status() {
  aws cloudformation describe-stacks --stack-name "$1" --query 'Stacks[0].StackStatus' --output text 2>/dev/null || printf 'ABSENT\n'
}
stack_last_updated() {
  aws cloudformation describe-stacks --stack-name "$1" \
    --query 'Stacks[0].[LastUpdatedTime,CreationTime]' --output text 2>/dev/null | tr '\t' ' '
}
stack_tag() { # stack key
  aws cloudformation describe-stacks --stack-name "$1" \
    --query "Stacks[0].Tags[?Key=='$2'].Value | [0]" --output text 2>/dev/null
}
stack_output() { # stack key
  aws cloudformation describe-stacks --stack-name "$1" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue | [0]" --output text 2>/dev/null
}
table_status() {
  aws dynamodb describe-table --table-name "$1" --query 'Table.TableStatus' --output text 2>/dev/null || printf 'ABSENT\n'
}

box_ip() { stack_output Shukkatest-Box PublicIp; }

# box_instance: the running shukkatest instance id.
box_instance() {
  aws ec2 describe-instances \
    --filters "Name=tag:Project,Values=$PROJECT" "Name=instance-state-name,Values=running" \
    --query 'Reservations[].Instances[].InstanceId' --output text 2>/dev/null | awk '{print $1}'
}

# box_run <shell command>: runs a read-only command on the shukkatest box through SSM, prints stdout.
box_run() {
  local iid cid status out
  iid=$(box_instance)
  [[ -n "$iid" ]] || { log "box_run: no running shukkatest instance"; return 1; }
  cid=$(aws ssm send-command --instance-ids "$iid" --document-name AWS-RunShellScript \
    --comment "shukkatest acceptance read" \
    --parameters "$(jq -nc --arg c "$1" '{commands: [$c]}')" \
    --query Command.CommandId --output text) || return 1
  for _ in $(seq 1 60); do
    sleep 3
    status=$(aws ssm get-command-invocation --command-id "$cid" --instance-id "$iid" \
      --query Status --output text 2>/dev/null || printf 'Pending')
    case "$status" in Pending | InProgress | Delayed) continue ;; esac
    break
  done
  out=$(aws ssm get-command-invocation --command-id "$cid" --instance-id "$iid" \
    --query StandardOutputContent --output text 2>/dev/null)
  printf '%s\n' "$out"
}

server_revision() { box_run "cat /opt/$PROJECT/$1/current/REVISION 2>/dev/null || echo NONE" | tr -d '[:space:]'; }
unit_started() { box_run "systemctl show -p ActiveEnterTimestampMonotonic --value $PROJECT-$1; systemctl is-active $PROJECT-$1" | tr '\n' ' ' | sed 's/ $//'; }

http_get() { curl -sS --max-time 10 "$@" 2>/dev/null; }
http_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$1" 2>/dev/null || printf '000'; }

# ---------------------------------------------------------------------------------------------
# Consumer working copy (cloned in setup)

c_git() { git -C "$RUN_DIR/consumer" "$@"; }

# commit_all <message>: commits everything in the consumer working copy, echoes the sha.
commit_all() {
  c_git add -A
  c_git commit -q -m "$1"
  c_git rev-parse HEAD
}
push_main() { c_git push -q origin HEAD:main; }

# json_edit <file-relative-to-consumer> <jq filter> [jq args...]
json_edit() {
  local f="$RUN_DIR/consumer/$1" tmp
  shift
  tmp=$(mktemp)
  jq "$@" "$f" >"$tmp" && mv -f "$tmp" "$f"
}
