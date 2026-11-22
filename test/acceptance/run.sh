#!/usr/bin/env bash
# shukka acceptance suite (shu-95y): runs shukka as a consumer would, against the private test
# consumer rummykhan/shukka-consumer-test calling a release-candidate tag, with throwaway shukkatest*
# resources in the shared AWS account. Tears everything down at the end, even after a failure.
#
#   bash test/acceptance/run.sh <rc-tag>      run every phase and case, then tear down
#   bash test/acceptance/run.sh --list        print every case id (one line each, prefixed shu-95y and
#                                             the task that last rewrote the case)
#   bash test/acceptance/run.sh --teardown    remove leftovers of an earlier run (found by name and tag)
#
# Environment: AWS_PROFILE (default stelking), AWS_REGION (default us-east-1),
#   SHUKKATEST_PHASES (default "A B C D D2 E F G H I J K"), SHUKKATEST_RUN_DIR (default a new temp dir),
#   SHUKKATEST_EXPECT_ACCOUNT (refuse any other account), SHUKKATEST_ZONE_DOMAIN, SHUKKATEST_TRENDIGLE_TABLE,
#   SHUKKATEST_TRENDIGLE_BUCKET, SHUKKATEST_GITHUB_REPO_SUBJECT, SHUKKATEST_INFRA_MODE_INPUT, JOB_RE_* (job names).
# Needs: gh (signed in as the owner), aws, jq, git, node 22, npm, curl, perl.
# Exit 0 only if every case passed and teardown left nothing behind.
# shellcheck source-path=SCRIPTDIR
set -uo pipefail

ACCEPT_DIR=$(cd "$(dirname "$0")" && pwd)
export ACCEPT_DIR
# shellcheck source=lib/common.sh
source "$ACCEPT_DIR/lib/common.sh"
# shellcheck source=lib/cli.sh
source "$ACCEPT_DIR/lib/cli.sh"
# shellcheck source=lib/setup.sh
source "$ACCEPT_DIR/lib/setup.sh"
# shellcheck source=lib/teardown.sh
source "$ACCEPT_DIR/lib/teardown.sh"
for f in "$ACCEPT_DIR"/phases/*.sh; do
  # shellcheck source=/dev/null
  source "$f"
done

ALL_PHASES="A B C D D2 E F G H I J K"

header() { sed -n "s/^# $2: *//p" "$1" | head -n 1; }

list_cases() {
  local f t n=0
  for f in "$ACCEPT_DIR"/cases/*.sh; do
    # A case's "# task:" header names the task that last rewrote it (after the suite's own).
    t=$(header "$f" task)
    printf '%s %-46s %-28s %s\n' "$SUITE_TASK${t:+,$t}" "$(header "$f" case)" "[$(header "$f" covers)]" "$(header "$f" title)"
    n=$((n + 1))
  done
  printf '%s: %d acceptance cases (not run: --list only names them)\n' "$SUITE_TASK" "$n" >&2
}

usage() { sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; }

case "${1:-}" in
  --list) list_cases; exit 0 ;;
  -h | --help) usage; exit 0 ;;
  --teardown)
    RUN_DIR=${SHUKKATEST_RUN_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/shukkatest-teardown.XXXXXX")}
    mkdir -p "$RUN_DIR/runs"
    if teardown; then exit 0; else exit 1; fi
    ;;
  "" | -*) usage; exit 2 ;;
esac

RC_TAG=$1
export RC_TAG
RUN_ID=$(date -u +%Y%m%d%H%M%S)
RUN_DIR=${SHUKKATEST_RUN_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/shukkatest.XXXXXX")}
mkdir -p "$RUN_DIR/runs"
RESULTS_FILE="$RUN_DIR/results.txt"
SUMMARY_FILE="$RUN_DIR/summary.txt"
: >"$RESULTS_FILE"
: >"$SUMMARY_FILE"
export RUN_ID RUN_DIR RESULTS_FILE
exec > >(tee -a "$RUN_DIR/run.log") 2>&1

log "shu-95y acceptance: shukka $RC_TAG against $CONSUMER_REPO, run $RUN_ID, files in $RUN_DIR"

# Preflight runs before the teardown trap: if leftovers of another run exist, stop without deleting.
setup_preflight
ACCOUNT=$(state_get account)
export ACCOUNT

# ---------------------------------------------------------------------------------------------

phase_file() { grep -l "^# phase: $1\$" "$ACCEPT_DIR"/phases/*.sh | head -n 1; }

# run_phase <X>: runs phase_X in a subshell unless a phase it needs did not succeed.
run_phase() {
  local p=$1 f needs n rc
  f=$(phase_file "$p")
  needs=$(header "$f" needs | tr ',' ' ')
  for n in $needs; do
    if [[ "$(state_get "phase_$n")" != ok ]]; then
      log "phase $p ($(header "$f" title)): blocked, phase $n did not succeed"
      state_set "phase_$p" blocked
      return 0
    fi
  done
  log "phase $p: $(header "$f" title)"
  ("phase_$p")
  rc=$?
  if [[ $rc == 0 ]]; then state_set "phase_$p" ok; else state_set "phase_$p" failed; log "phase $p failed ($rc)"; fi
}

# run_cases <X>: runs every case of phase X; each case runs in its own subshell.
run_cases() {
  local p=$1 f id status verdict
  status=$(state_get "phase_$p")
  for f in "$ACCEPT_DIR"/cases/*.sh; do
    [[ "$(header "$f" phase)" == "$p" ]] || continue
    id=$(header "$f" case)
    if [[ "$status" == blocked || -z "$status" ]]; then
      verdict=BLOCKED
    else
      log "case $id: $(header "$f" title)"
      if (
        CASE_FAILS=0
        # shellcheck source=/dev/null
        source "$f"
        case_run
        exit $((CASE_FAILS > 0 ? 1 : 0))
      ); then verdict=PASS; else verdict=FAIL; fi
    fi
    printf 'CASE %s %s %s\n' "$SUITE_TASK" "$id" "$verdict" | tee -a "$SUMMARY_FILE" >&2
  done
}

FINISHED=0
on_exit() {
  local td=0 fails
  ((FINISHED)) && return
  FINISHED=1
  trap - INT TERM
  teardown || td=1
  state_set phase_T ok
  run_cases T
  fails=$(grep -cv ' PASS$' "$SUMMARY_FILE" || true)
  log "summary: $(grep -c ' PASS$' "$SUMMARY_FILE" || true) passed, $fails not passed; teardown $([[ $td == 0 ]] && echo clean || echo INCOMPLETE)"
  grep -v ' PASS$' "$SUMMARY_FILE" >&2 || true
  log "log: $RUN_DIR/run.log  results: $RESULTS_FILE"
  if [[ $td != 0 ]]; then
    log "TEARDOWN INCOMPLETE: stop and clean up by hand (see LEFTOVER lines above), then 'run.sh --teardown'"
  fi
  if [[ $td == 0 && $fails == 0 ]]; then exit 0; else exit 1; fi
}
trap on_exit EXIT
trap 'log "interrupted"; exit 130' INT TERM

for p in ${SHUKKATEST_PHASES:-$ALL_PHASES}; do
  run_phase "$p"
  run_cases "$p"
done
