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
# shukka bootstrap's two stacks (lib/bootstrap.ts bootstrapStackName/boundaryStackName). Neither starts
# with the project name (the project's deploy role could change them), so they are named here exactly.
# shellcheck disable=SC2034
BOOTSTRAP_STACK=CDKToolkit-$QUALIFIER
# shellcheck disable=SC2034
BOUNDARY_STACK=Shukka-Boundary-$PROJECT
# shellcheck disable=SC2034
SHUKKA_REPO=${SHUKKATEST_SHUKKA_REPO:-rummykhan/shukka}
# The only repository this suite may push to (it force-pushes main). Not overridable on purpose.
readonly CONSUMER_REPO=rummykhan/shukka-consumer-test
CALLER_WORKFLOW=${SHUKKATEST_CALLER_WORKFLOW:-CI}          # the caller's `name:`
# shellcheck disable=SC2034
PROBE_WORKFLOW=shukkatest-probe                            # probe workflows' `name:` prefix
export AWS_PROFILE=${AWS_PROFILE:-stelking}
export AWS_REGION=${AWS_REGION:-us-east-1}
export AWS_DEFAULT_REGION=$AWS_REGION
export AWS_PAGER=""
export GH_PAGER=""

# Job display names, matched case-insensitively against `gh run view --json jobs` names. The caller's
# job is `shukka`, so pipeline.yml's jobs read "shukka / plan", "shukka / check <name>",
# "shukka / build <app>", and the nested ones "shukka / stacks / synth|changes|deploy",
# "shukka / pull request / synth|diff|comment", "shukka / servers / changes|release <app>",
# "shukka / smoke" (names from pipeline.yml, infra.yml and ec2.yml since shu-9zr). Adjust here only.
JOB_RE_PLAN=${JOB_RE_PLAN:-'plan'}
JOB_RE_CHECKS=${JOB_RE_CHECKS:-'check'}
JOB_RE_BUILD=${JOB_RE_BUILD:-'build'}
# The infra deploy job (the guard, the assembly check and cdk deploy run here).
JOB_RE_INFRA=${JOB_RE_INFRA:-'stacks / deploy'}
# The job without id-token that runs the project's npm ci and cdk synth, on a merge and on a PR.
JOB_RE_INFRA_SYNTH=${JOB_RE_INFRA_SYNTH:-'stacks / synth'}
JOB_RE_PR_SYNTH=${JOB_RE_PR_SYNTH:-'pull request / synth'}
JOB_RE_DIFF=${JOB_RE_DIFF:-'pull request / diff'}
JOB_RE_COMMENT=${JOB_RE_COMMENT:-'pull request / comment'}
JOB_RE_APP=${JOB_RE_APP:-'servers / release'}
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

# Assertions used inside case_run. They never exit; they count failures in CASE_FAILS and, when the
# case runs under case_exec, also in CASE_FAIL_FILE, so a failure made inside $(...) (need_state's,
# typically) still reaches the case: a subshell's CASE_FAILS is lost, a line in the file is not.
CASE_FAILS=${CASE_FAILS:-0}
ok() { printf '    ok - %s\n' "$*" >&2; }
fail() {
  printf '    not ok - %s\n' "$*" >&2
  CASE_FAILS=$((CASE_FAILS + 1))
  if [[ -n "${CASE_FAIL_FILE:-}" ]]; then printf '%s\n' "$*" >>"$CASE_FAIL_FILE"; fi
}
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

# state_set <key> <value>: a value is one line of state.env. A multi-line value (raw CLI output, which
# often starts with a newline) is flattened, its non-blank lines joined by spaces, rather than lost.
state_set() {
  local v=$2
  if [[ "$v" == *[$'\n\r']* ]]; then v=$(printf '%s\n' "$v" | one_line); fi
  printf '%s=%s\n' "$1" "$v" >>"$RUN_DIR/state.env"
}
# one_line: stdin's non-blank lines joined by single spaces (for CLI output kept in state).
one_line() { tr -d '\r' | awk 'NF' | paste -sd ' ' -; }
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

# case_exec <case-file>: runs the file's case_run in a subshell; succeeds only if no assertion failed,
# counting failures made in command substitutions (a missing need_state value) as well as direct ones.
case_exec() {
  local ff rc
  ff=$(mktemp "${RUN_DIR:-${TMPDIR:-/tmp}}/case-fails.XXXXXX") || return 1
  (
    CASE_FAILS=0
    CASE_FAIL_FILE=$ff
    # shellcheck source=/dev/null
    source "$1"
    case_run
    exit $((CASE_FAILS > 0 ? 1 : 0))
  )
  rc=$?
  if [[ -s "$ff" ]]; then rc=1; fi
  rm -f "$ff"
  return $rc
}

# release_line_re <app> <old> <new> <result>: a regex for the line box/shukka-release.sh prints when a
# release on the box finishes ("shukka: <project>/<app> <old> -> <new> <result>"). The rollback cases
# require it before they compare current/previous, which would otherwise match when no release ran.
release_line_re() { printf 'shukka: %s/%s %s -> %s %s' "$PROJECT" "$1" "$2" "$3" "$4"; }

# ---------------------------------------------------------------------------------------------
# Safety: the only names this suite may change or delete.

is_ours() {
  [[ "$1" =~ ^(shukkatest|Shukkatest|cdk-shukkatest-|standin-shukkatest|Standin-shukkatest) ]] ||
    [[ "$1" == "$BOOTSTRAP_STACK" || "$1" == "$BOUNDARY_STACK" ]]
}
require_ours() {
  is_ours "$1" || die "refusing to touch '$1': not a shukkatest resource"
}

# text_items: the items of an `aws ... --output text` listing, one per line, without blanks and without
# the literal None the CLI prints for a null result (a missing key, `| [0]` of an empty list). Every
# discovery that feeds a delete reads its names through this, so "nothing found" is never a name.
text_items() { tr '\t' '\n' | grep -Exv '(None)?' || true; }

# ---------------------------------------------------------------------------------------------
# Polling

# Waits count awake time, not wall-clock time (shu-9bj.22): a laptop that sleeps for hours in the middle
# of a wait must not find the wait timed out the moment it wakes. Each pass of a polling loop adds the
# time since the previous pass, but at most its interval plus WAIT_STEP_SLACK seconds (room for the
# gh or aws call in between), so a sleep gap counts as one pass.
WAIT_STEP_SLACK=${WAIT_STEP_SLACK:-60}

# awake_step <last-epoch> <interval>: prints "<now> <step>", step being the capped time since last.
awake_step() {
  local now step
  now=$(date +%s)
  step=$((now - $1))
  ((step < 0)) && step=0
  ((step > $2 + WAIT_STEP_SLACK)) && step=$(($2 + WAIT_STEP_SLACK))
  printf '%s %s\n' "$now" "$step"
}

# keep_awake: keeps a Mac from sleeping (idle and system sleep) for as long as this shell runs, with
# caffeinate when there is one. A sleeping laptop drops the network under every gh and aws call.
keep_awake() {
  if command -v caffeinate >/dev/null 2>&1; then
    caffeinate -i -s -w "$$" >/dev/null 2>&1 &
    log "caffeinate keeps this machine awake while the run lasts (pid $!)"
  fi
}

# gh_read <gh args...>: a read through gh, retried (GH_READ_TRIES times, a growing pause apart) when gh
# fails on a network error; any other failure is returned at once. stdout is gh's; on the last failure
# gh's stderr is passed on.
GH_READ_TRIES=${GH_READ_TRIES:-5}
GH_NETWORK_ERROR_RE='error connecting to|dial tcp|no such host|connection (reset|refused)|i/o timeout|TLS handshake|timeout awaiting|context deadline exceeded|unexpected EOF|network is (down|unreachable)|could not resolve|HTTP 50[234]'
gh_read() {
  local i errf out rc
  errf=$(mktemp "${TMPDIR:-/tmp}/gh-read.XXXXXX") || return 1
  for ((i = 1; ; i++)); do
    out=$(gh "$@" 2>"$errf")
    rc=$?
    if ((rc == 0)) || ((i >= GH_READ_TRIES)) || ! grep -Eiq -- "$GH_NETWORK_ERROR_RE" "$errf"; then break; fi
    log "gh $1 $2: network error (try $i of $GH_READ_TRIES): $(one_line <"$errf" | cut -c1-160)"
    sleep $((i * 5))
  done
  ((rc == 0)) || cat "$errf" >&2
  rm -f "$errf"
  [[ -z "$out" ]] || printf '%s\n' "$out"
  return $rc
}

# wait_until <timeout-seconds> <interval-seconds> <command...>: retries until the command succeeds.
wait_until() {
  local timeout=$1 interval=$2 last waited=0 now step
  shift 2
  last=$(date +%s)
  until "$@"; do
    read -r now step <<<"$(awake_step "$last" "$interval")"
    last=$now waited=$((waited + step))
    if ((waited >= timeout)); then return 1; fi
    sleep "$interval"
  done
}

# ---------------------------------------------------------------------------------------------
# GitHub runs in the test consumer

# How long a pushed commit's run may take to appear, and how many times (2s apart) to look for a workflow
# to turn active after enabling it. Overridable for the stubbed tests.
RUN_APPEAR_TIMEOUT=${RUN_APPEAR_TIMEOUT:-300}
WORKFLOW_ACTIVE_TRIES=${WORKFLOW_ACTIVE_TRIES:-15}

# workflow_info <workflow-name>: "<id> <state> <path>" of the test consumer's workflow with that `name:`
# (the active one if several), or nothing. state is active, disabled_manually, disabled_inactivity, ...
workflow_info() {
  gh_read api "repos/$CONSUMER_REPO/actions/workflows" --paginate --jq '.workflows[]' 2>/dev/null |
    jq -rs --arg w "$1" '[.[] | select(.name == $w)] | (map(select(.state == "active")) + .) | first // empty
      | "\(.id) \(.state) \(.path)"'
}
# workflow_state <workflow-name>: its state as gh reports it, or "not found".
workflow_state() {
  local id state path
  read -r id state path <<<"$(workflow_info "$1")"
  printf '%s\n' "${state:-not found}"
}

# enable_workflow <workflow-name>: enables it in the test consumer and waits (bounded) until gh reports it
# active; dies otherwise. A push made before it is active starts no run (shu-9bj.17).
enable_workflow() {
  local wf=$1 i state
  state=$(workflow_state "$wf")
  if [[ "$state" != active ]]; then
    gh workflow enable "$wf" -R "$CONSUMER_REPO" >/dev/null ||
      die "cannot enable the caller workflow '$wf' in $CONSUMER_REPO (gh workflow enable failed; it is $state)"
    for ((i = 0; i < WORKFLOW_ACTIVE_TRIES; i++)); do
      state=$(workflow_state "$wf")
      [[ "$state" == active ]] && break
      sleep 2
    done
    [[ "$state" == active ]] ||
      die "caller workflow '$wf' is still '$state' in $CONSUMER_REPO $((WORKFLOW_ACTIVE_TRIES * 2))s after enabling it"
  fi
  log "workflow '$wf' is active in $CONSUMER_REPO"
}

# probe_workflows_inactive: "<id> <name> <state>" of each probe workflow (name starting with
# $PROBE_WORKFLOW) the test consumer knows and that is not active.
probe_workflows_inactive() {
  gh_read api "repos/$CONSUMER_REPO/actions/workflows" --paginate --jq '.workflows[]' 2>/dev/null |
    jq -r --arg p "$PROBE_WORKFLOW" 'select((.name | startswith($p)) and .state != "active") | "\(.id) \(.name) \(.state)"'
}

# enable_probe_workflows: teardown disables every workflow in the test consumer and a probe workflow keeps
# its id (and state) across runs, so enable each known probe workflow by id before pushing it, and wait
# (bounded) until none is inactive; dies otherwise. A probe GitHub has never seen starts out active.
enable_probe_workflows() {
  local id name state i left
  while read -r id name state; do
    [[ -n "$id" ]] || continue
    gh workflow enable "$id" -R "$CONSUMER_REPO" >/dev/null ||
      die "cannot enable the probe workflow '$name' ($id) in $CONSUMER_REPO (gh workflow enable failed; it is $state)"
  done <<<"$(probe_workflows_inactive)"
  for ((i = 0; i < WORKFLOW_ACTIVE_TRIES; i++)); do
    left=$(probe_workflows_inactive)
    [[ -z "$left" ]] && break
    sleep 2
  done
  [[ -z "$left" ]] ||
    die "probe workflows still not active in $CONSUMER_REPO $((WORKFLOW_ACTIVE_TRIES * 2))s after enabling them: $(tr '\n' ';' <<<"$left")"
  log "probe workflows are active in $CONSUMER_REPO"
}

# run_for_sha <sha> <workflow-name> <event> [head-branch-or-tag] [workflow-id] [workflow-path]: the newest
# matching run as "<id> <run name>", or nothing. A run GitHub could not start (startup failure, a workflow
# file issue) is named by its file path, not its `name:`, so it is also matched by workflow id and path.
run_for_sha() {
  gh_read run list -R "$CONSUMER_REPO" --commit "$1" --limit 50 \
    --json databaseId,workflowName,workflowDatabaseId,event,createdAt,headBranch 2>/dev/null |
    jq -r --arg w "$2" --arg e "$3" --arg b "${4:-}" --arg i "${5:-}" --arg p "${6:-}" \
      '[.[] | select((.workflowName == $w or ($p != "" and .workflowName == $p)
                      or ($i != "" and ((.workflowDatabaseId // "") | tostring) == $i))
                     and .event == $e and ($b == "" or .headBranch == $b))]
       | sort_by(.createdAt) | last | select(. != null) | "\(.databaseId) \(.workflowName)"'
}

# wait_run_for_sha <sha> <workflow-name> <event> [head-branch-or-tag] [appear-timeout]: echoes the run id.
# If no run appears, says what state the workflow is in and how many runs the commit has at all.
wait_run_for_sha() {
  local sha=$1 wf=$2 ev=$3 head=${4:-} timeout=${5:-$RUN_APPEAR_TIMEOUT} last waited=0 now step hit id name wid wstate wpath
  read -r wid wstate wpath <<<"$(workflow_info "$wf")"
  last=$(date +%s)
  while :; do
    hit=$(run_for_sha "$sha" "$wf" "$ev" "$head" "${wid:-}" "${wpath:-}")
    if [[ -n "$hit" ]]; then
      read -r id name <<<"$hit"
      if [[ "$name" != "$wf" ]]; then
        log "run $id for ${sha:0:12} is named '$name', not '$wf': GitHub could not start the workflow (startup failure, a workflow file issue)"
      fi
      printf '%s\n' "$id"
      return 0
    fi
    read -r now step <<<"$(awake_step "$last" 10)"
    last=$now waited=$((waited + step))
    if ((waited >= timeout)); then
      log "no '$wf' run for $ev at $sha after ${timeout}s awake; caller '$wf' is $(workflow_state "$wf")${wpath:+ ($wpath)} in $CONSUMER_REPO; runs for this commit of any workflow: $(runs_for_sha_count "$sha")"
      return 1
    fi
    sleep 10
  done
}

# wait_run_done <run-id> [timeout]: waits for completion, echoes the conclusion.
wait_run_done() {
  local id=$1 timeout=${2:-2700} last waited=0 now step status
  last=$(date +%s)
  while :; do
    status=$(gh_read run view "$id" -R "$CONSUMER_REPO" --json status,conclusion -q '.status + " " + (.conclusion // "")' 2>/dev/null || true)
    if [[ "$status" == completed* ]]; then
      printf '%s\n' "${status#completed }"
      return 0
    fi
    read -r now step <<<"$(awake_step "$last" 15)"
    last=$now waited=$((waited + step))
    if ((waited >= timeout)); then
      log "run $id still '$status' after ${timeout}s awake"
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
  local since=$1 id last waited=0 now step concl
  shift
  gh workflow run "$CALLER_WORKFLOW" -R "$CONSUMER_REPO" --ref main "$@" >/dev/null || return 1
  last=$(date +%s)
  while :; do
    id=$(gh_read run list -R "$CONSUMER_REPO" --workflow "$CALLER_WORKFLOW" --event workflow_dispatch --limit 10 \
      --json databaseId,createdAt -q "[.[] | select(.createdAt >= \"$since\")] | sort_by(.createdAt) | last | .databaseId // empty")
    [[ -n "$id" ]] && break
    read -r now step <<<"$(awake_step "$last" 10)"
    last=$now waited=$((waited + step))
    ((waited < 300)) || { log "no workflow_dispatch run appeared"; return 1; }
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
  gh_read run list -R "$CONSUMER_REPO" --commit "$1" --limit 50 --json databaseId -q 'length' 2>/dev/null || printf '0\n'
}

# pr_diff_comments <pr-number>: JSON array of {id, updated_at, body} for comments with the marker.
pr_diff_comments() {
  gh_read api "repos/$CONSUMER_REPO/issues/$1/comments" --paginate \
    --jq '[.[] | select(.body | contains("<!-- shukka:diff -->")) | {id, updated_at, body}]' 2>/dev/null |
    jq -s 'add // []'
}

run_conclusion() { gh_read run view "$1" -R "$CONSUMER_REPO" --json conclusion -q .conclusion; }

# run_jobs <run-id>: JSON array of {name, conclusion, startedAt, completedAt}.
run_jobs() {
  local f="$RUN_DIR/runs/$1.jobs.json"
  if [[ ! -s "$f" ]]; then
    mkdir -p "$RUN_DIR/runs"
    gh_read run view "$1" -R "$CONSUMER_REPO" --json jobs -q '[.jobs[] | {name, conclusion, status, startedAt, completedAt}]' >"$f"
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
gh_fetch_log() { gh_read run view "$1" -R "$CONSUMER_REPO" --log >"$2" 2>/dev/null && [[ -s "$2" ]]; }

# job_messages <run-id> <job-regex>: the printed lines of the matching jobs, without the job, step and
# timestamp columns. Lines GitHub prints for a step's `env:`/`with:` are indented, so a caller that
# anchors at the start of a line (^guard: ...) only sees what the step itself printed. A leading
# "##[error]" (an ::error:: annotation) is removed.
job_messages() {
  awk -F'\t' -v re="$2" 'tolower($1) ~ tolower(re) { $1 = ""; $2 = ""; sub(/^\t\t/, ""); print }' OFS='\t' "$(run_log "$1")" |
    sed -E 's/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z ?//; s/^##\[error\]//'
}

# The texts the suite matches, case-sensitively and anchored at the start of a printed line. Agreed
# with shu-9zr (workflows) on its mailbox; the guard's lines are scripts/guard.mjs's report.
# shellcheck disable=SC2034 # used by cases
GUARD_HEADER='guard: these changes delete or replace a resource:'
# shellcheck disable=SC2034
GUARD_STOP_RE='^guard: stopping\. If this is intended, run the workflow by hand on main with allow_replacement ticked\.$'
# shellcheck disable=SC2034
SMOKE_FAILED_RE='^shukka: the site is live but failing its smoke test'

# guard_offending <messages>: the lines between the guard's header and its stop line.
guard_offending() {
  awk -v h="$GUARD_HEADER" '$0 == h { on = 1; next } /^guard: / { on = 0 } on' <<<"$1"
}

# observed <log-file> <observation-id>: the verdict a probe printed ("RESULT <id> <VERDICT> ..."), or
# MISSING. Verdicts are upper case and may hold a dash (NO-TOKEN, NO-CREDS).
observed() {
  local v
  v=$(grep -Eo "RESULT $2 [A-Z][A-Z-]*" "$1" | head -n 1 | awk '{print $3}')
  printf '%s\n' "${v:-MISSING}"
}

# expect_observation <log-file> <observation-id> <expected-verdict> <run-id>
# Re-emits the probe's line into the suite log as RESULT <id> <verdict>, and asserts it.
expect_observation() {
  local v detail
  v=$(observed "$1" "$2")
  detail=$(grep -Eo "RESULT $2 [A-Z][A-Z-]*.*" "$1" | head -n 1 | cut -d' ' -f4- | cut -c1-160)
  result "$2" "$v" "(run $4${detail:+: $detail})"
  assert_eq "$v" "$3" "$2 is $3"
}

# job_messages_file <run-id> <job-regex> <name>: job_messages saved under the run directory, so an
# observation can be read from exactly one job (expect_observation takes a file).
job_messages_file() {
  local f="$RUN_DIR/runs/$1.$3.messages.txt"
  job_messages "$1" "$2" >"$f"
  printf '%s\n' "$f"
}

# ---------------------------------------------------------------------------------------------
# Admin-side refusal checks (shu-9bj.3)
#
# Since shu-9zr no project code runs in a job that holds a role, so nothing the suite plants in the
# consumer can act as the infra, diff or project deploy role. What those roles may do is read from IAM
# with the admin profile: simulate-principal-policy evaluates the role's identity policies and its
# permissions boundary for one action on one resource (not resource policies, not SCPs, and not the
# target role's trust policy for sts:AssumeRole: a refusal on the caller's side is enough to refuse).
# Each set has an ALLOWED control with the same action and context shape, so a wrong ARN or a missing
# context key cannot pass as a refusal.

# simulated <role-arn> <action> <resource-arn> [key=value...]: allowed|explicitDeny|implicitDeny|ERROR.
# Context values are strings; aws:RequestedRegion is always supplied.
simulated() {
  local role=$1 action=$2 resource=$3 kv out
  shift 3
  local ctx=("ContextKeyName=aws:RequestedRegion,ContextKeyValues=$AWS_REGION,ContextKeyType=string")
  for kv in "$@"; do
    ctx+=("ContextKeyName=${kv%%=*},ContextKeyValues=${kv#*=},ContextKeyType=string")
  done
  out=$(aws iam simulate-principal-policy --policy-source-arn "$role" --action-names "$action" \
    --resource-arns "$resource" --context-entries "${ctx[@]}" \
    --query 'EvaluationResults[0].EvalDecision' --output text 2>&1) || { printf 'ERROR %s\n' "$(tr '\n' ' ' <<<"$out" | cut -c1-160)"; return 0; }
  printf '%s\n' "$out"
}

# expect_simulated <observation-id> <ALLOWED|DENIED> <role-arn> <action> <resource-arn> [key=value...]
# Prints "RESULT <id> <verdict> (simulator: ...)" in the suite log and asserts it.
expect_simulated() {
  local id=$1 want=$2 role=$3 action=$4 resource=$5 d v
  shift 5
  d=$(simulated "$role" "$action" "$resource" "$@")
  case "$d" in
    allowed) v=ALLOWED ;;
    explicitDeny | implicitDeny) v=DENIED ;;
    *) v=ERROR ;;
  esac
  result "$id" "$v" "(simulator: ${role##*/} $action on $resource: $d)"
  assert_eq "$v" "$want" "$id is $want (IAM simulator)"
}

# stack_arn <name>: the stack's full id, or a name-only ARN when it does not exist (a refusal then
# still has a resource to be evaluated on).
stack_arn() {
  aws cloudformation describe-stacks --stack-name "$1" --query 'Stacks[0].StackId' --output text 2>/dev/null ||
    printf 'arn:aws:cloudformation:%s:%s:stack/%s/00000000-0000-0000-0000-000000000000\n' "$AWS_REGION" "$ACCOUNT" "$1"
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

# iso_epoch: an AWS timestamp (2026-11-22T10:00:00.123000+00:00 or ...Z) as seconds since the epoch.
iso_epoch() { jq -Rr 'sub("\\.[0-9]+"; "") | sub("\\+00:00$"; "Z") | fromdateiso8601'; }

# release_command_id <app> <sha> <run-id>: the id of the SSM command the run's release job sent for that
# app and commit, read from the job's own line (scripts/release.mjs: "shukka: sent release of
# <project>/<app> <sha> to <instances> (command <id>)"), or nothing.
release_command_id() {
  job_messages "$3" "$JOB_RE_APP" |
    sed -nE "s/^shukka: sent release of $PROJECT\/$1 $2 to .* \(command ([^ )]+)\)\$/\1/p" | tail -n 1
}

# release_command_window <app> <sha> <run-id> [invoked-after-iso8601]: "<start-epoch> <end-epoch>" of the
# SSM command that ran shukka-release.sh for that app and commit on the box (from SSM's own records), or
# nothing. The command id comes from the run's release job log; failing that, from SSM's listing of the
# commands sent to the box since invoked-after, read in full (every page) and newest first (shu-9bj.22:
# a first page of list-commands is not in time order).
release_command_window() {
  local iid cid times
  iid=$(box_instance)
  [[ -n "$iid" ]] || return 1
  cid=$(release_command_id "$1" "$2" "$3")
  if [[ -z "$cid" && -n "${4:-}" ]]; then
    cid=$(aws ssm list-commands --instance-id "$iid" --filters "key=InvokedAfter,value=$4" --output json 2>/dev/null |
      jq -r --arg sha "$2" --arg app "$1" '[.Commands[] | select((.Parameters | tostring) as $p
        | ($p | contains($sha)) and ($p | contains("--app")) and ($p | contains($app)))]
        | sort_by(.RequestedDateTime) | last | .CommandId // empty')
  fi
  [[ -n "$cid" ]] || return 1
  times=$(aws ssm get-command-invocation --command-id "$cid" --instance-id "$iid" \
    --query '[ExecutionStartDateTime, ExecutionEndDateTime]' --output text 2>/dev/null) || return 1
  printf '%s %s\n' "$(awk '{print $1}' <<<"$times" | iso_epoch)" "$(awk '{print $2}' <<<"$times" | iso_epoch)"
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
# require_consumer_remote: the working copy's origin must be the test consumer, nothing else.
require_consumer_remote() {
  local url
  url=$(c_git remote get-url origin 2>/dev/null)
  [[ "$CONSUMER_REPO" == rummykhan/shukka-consumer-test ]] || die "refusing to push: CONSUMER_REPO is '$CONSUMER_REPO'"
  [[ "$url" =~ [:/]rummykhan/shukka-consumer-test(\.git)?$ ]] || die "refusing to push: origin is '$url', not $CONSUMER_REPO"
}
push_main() { require_consumer_remote && c_git push -q origin HEAD:main; }

# json_edit <file-relative-to-consumer> <jq filter> [jq args...]
json_edit() {
  local f="$RUN_DIR/consumer/$1" tmp
  shift
  tmp=$(mktemp)
  jq "$@" "$f" >"$tmp" && mv -f "$tmp" "$f"
}
