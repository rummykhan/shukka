import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// The acceptance suite's shell helpers (test/acceptance/lib), run against stubbed aws and gh so no
// account is touched. Each aws call is logged as its arguments separated by a unit separator.

const lib = resolve(import.meta.dirname, 'acceptance', 'lib');
const SEP = '\x1f';

/** A stub aws: logs every call; `--output text` queries print the literal None (what the CLI prints for a null). */
const awsStub = `#!/usr/bin/env bash
log="$STUB_DIR/aws.log"
( IFS=$'\\x1f'; printf '%s\\n' "$*" ) >>"$log"
case "$1 $2" in
  "sts get-caller-identity") printf '123456789012\\n'; exit 0 ;;
  "route53 create-hosted-zone") printf '/hostedzone/ZSTUB\\tns-1.example.net\\n'; exit 0 ;;
esac
for a in "$@"; do
  if [[ "$a" == text ]]; then printf 'None\\n'; exit 0; fi
done
exit 0
`;

function withStubs(
  script: string,
  opts: { aws?: string; stacks?: string } = {},
): { status: number | null; stdout: string; stderr: string; calls: string[][] } {
  const dir = mkdtempSync(join(tmpdir(), 'shu-9bj13-'));
  try {
    const bin = join(dir, 'bin');
    spawnSync('mkdir', ['-p', bin, join(dir, 'run', 'runs')]);
    writeFileSync(join(bin, 'aws'), opts.aws ?? awsStub);
    writeFileSync(join(dir, 'stacks'), opts.stacks ?? '');
    writeFileSync(join(bin, 'gh'), '#!/usr/bin/env bash\nexit 0\n');
    writeFileSync(join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');
    for (const f of ['aws', 'gh', 'sleep']) chmodSync(join(bin, f), 0o755);
    writeFileSync(join(dir, 'aws.log'), '');
    const r = spawnSync(
      'bash',
      ['-c', `set -uo pipefail; source "${lib}/common.sh"; source "${lib}/setup.sh"; source "${lib}/teardown.sh"; ${script}`],
      {
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, STUB_DIR: dir, RUN_DIR: join(dir, 'run'), AWS_PROFILE: 'stub' },
      },
    );
    const calls = readFileSync(join(dir, 'aws.log'), 'utf8')
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => l.split(SEP));
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('shu-9bj.13: setup_zone passes the hosted-zone comment as one JSON value, not shorthand split on its comma', () => {
  const r = withStubs('RUN_ID=20261123015024; setup_zone');
  assert.equal(r.status, 0, r.stderr);
  const create = r.calls.find((c) => c[0] === 'route53' && c[1] === 'create-hosted-zone');
  assert.ok(create, 'create-hosted-zone was called');
  const i = create.indexOf('--hosted-zone-config');
  assert.ok(i > 0, '--hosted-zone-config is passed');
  const config: unknown = JSON.parse(create[i + 1] ?? '');
  assert.deepEqual(config, { Comment: 'shukka acceptance 20261123015024, delete within 12 hours' });
});

test('shu-9bj.13: setup.sh passes no aws shorthand value that holds a comma inside a quoted field', () => {
  // Shorthand like Key=Value,Other="a, b" is split by the CLI on the comma; such values go as JSON.
  const src = readFileSync(join(lib, 'setup.sh'), 'utf8');
  const offenders = src.split('\n').filter((l) => /\b[A-Z][A-Za-z]*="[^"]*,[^"]*"/.test(l));
  assert.deepEqual(offenders, []);
});

test('shu-9bj.13: teardown with every aws text query answering None runs to the end and touches no "None"', () => {
  const r = withStubs('teardown');
  assert.doesNotMatch(r.stderr, /refusing to touch/);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /teardown: clean/);
  // Every step ran: the last discovery (hosted zones) and the leftovers check were reached.
  assert.ok(r.calls.some((c) => c[0] === 'route53' && c[1] === 'list-hosted-zones'), 'td_zones ran');
  assert.ok(r.calls.some((c) => c[0] === 'resourcegroupstaggingapi'), 'leftovers ran');
  // No delete or describe was ever aimed at a resource named None.
  const aimedAtNone = r.calls.filter((c) => c.slice(2).some((a, k) => a === 'None' && c[k + 1]?.startsWith('--')));
  assert.deepEqual(aimedAtNone, []);
});

// A stub aws that keeps CloudFormation stacks in $STUB_DIR/stacks (one "name status" per line), the way
// shukka bootstrap leaves them: CDKToolkit-<qualifier> (no Qualifier parameter) holding the retained
// assets bucket, and Shukka-Boundary-<project>, whose delete fails while the bootstrap's execution role
// still has its policies attached.
const stackStub = `#!/usr/bin/env bash
log="$STUB_DIR/aws.log"
st="$STUB_DIR/stacks"
( IFS=$'\\x1f'; printf '%s\\n' "$*" ) >>"$log"
arg() { local k=$1; shift; while (($#)); do [[ "$1" == "$k" ]] && { printf '%s' "$2"; return; }; shift; done; }
name=$(arg --stack-name "$@")
query=$(arg --query "$@")
status_of() { awk -v n="$1" '$1 == n && $2 != "DELETE_COMPLETE" {print $2}' "$st"; }
case "$1 $2" in
  "sts get-caller-identity") printf '123456789012\\n'; exit 0 ;;
  "cloudformation list-stacks") awk '$2 != "DELETE_COMPLETE" {print $1}' "$st" | paste -sd '\\t' -; exit 0 ;;
  "cloudformation describe-stacks")
    if [[ -n "$name" ]]; then
      s=$(status_of "$name"); [[ -n "$s" ]] || { echo "Stack with id $name does not exist" >&2; exit 254; }
      printf '%s\\n' "$s"; exit 0
    fi ;;
  "cloudformation delete-stack")
    new=DELETE_COMPLETE
    if [[ "$name" == Shukka-Boundary-shukkatest && -n "$(status_of CDKToolkit-shukkatest)" ]]; then new=DELETE_FAILED; fi
    awk -v n="$name" -v s="$new" '$1 == n {$2 = s} {print}' "$st" >"$st.new" && mv "$st.new" "$st"
    exit 0 ;;
  "cloudformation describe-stack-resources")
    if [[ "$name" == CDKToolkit-shukkatest && "$query" == *S3::Bucket* ]]; then
      printf 'cdk-shukkatest-assets-123456789012-us-east-1\\n'; exit 0
    fi ;;
esac
for a in "$@"; do
  if [[ "$a" == text ]]; then printf 'None\\n'; exit 0; fi
done
exit 0
`;

const liveStacks = [
  'CDKToolkit CREATE_COMPLETE',
  'CDKToolkit-shukkatest CREATE_COMPLETE',
  'Shukka-Boundary-shukkatest CREATE_COMPLETE',
  'CDKToolkit-trendigle CREATE_COMPLETE',
  'Shukka-Boundary-trendigle CREATE_COMPLETE',
  'CDKToolkit-shukkatestx CREATE_COMPLETE',
  'Shukka-Boundary-shukkatestx CREATE_COMPLETE',
  'Shukka-Account CREATE_COMPLETE',
  'Shukkatest-Box CREATE_COMPLETE',
].join('\n');

function lines(s: string): string[] {
  return s.split('\n').filter((l) => l !== '').sort();
}

test("shu-9bj.14: discovery finds shukka's CDKToolkit-shukkatest and Shukka-Boundary-shukkatest by name, never CDKToolkit or another project's", () => {
  const run = (fn: string) => {
    const r = withStubs(fn, { aws: stackStub, stacks: liveStacks });
    assert.equal(r.status, 0, r.stderr);
    return lines(r.stdout);
  };
  assert.deepEqual(run('our_stacks'), ['CDKToolkit-shukkatest', 'Shukka-Boundary-shukkatest', 'Shukkatest-Box']);
  assert.deepEqual(run('qualifier_stacks'), ['CDKToolkit-shukkatest']);
  assert.deepEqual(run('boundary_stacks'), ['Shukka-Boundary-shukkatest']);
  assert.deepEqual(run('project_stacks'), ['Shukkatest-Box']);
});

test('shu-9bj.14: the safety check accepts exactly the two bootstrap stack names and delete_stack refuses the rest', () => {
  const ours = ['CDKToolkit-shukkatest', 'Shukka-Boundary-shukkatest'];
  const notOurs = [
    'CDKToolkit',
    'CDKToolkit-trendigle',
    'Shukka-Boundary-trendigle',
    'CDKToolkit-shukkatestx',
    'Shukka-Boundary-shukkatestx',
    'CDKToolkit-shukkatest-x',
    'Shukka-Account',
  ];
  for (const n of ours) assert.equal(withStubs(`require_ours ${n}`).status, 0, n);
  for (const n of notOurs) {
    assert.notEqual(withStubs(`is_ours ${n}`).status, 0, `is_ours ${n}`);
    const r = withStubs(`delete_stack ${n}`, { aws: stackStub, stacks: liveStacks });
    assert.notEqual(r.status, 0, `delete_stack ${n}`);
    assert.match(r.stderr, /refusing to delete stack/, n);
    assert.ok(!r.calls.some((c) => c[1] === 'delete-stack'), `no delete-stack for ${n}`);
  }
});

test('shu-9bj.14: teardown empties the assets bucket, deletes the bootstrap stack, then retries the DELETE_FAILED boundary stack, and ends clean', () => {
  const stacks = ['CDKToolkit CREATE_COMPLETE', 'CDKToolkit-shukkatest CREATE_COMPLETE', 'Shukka-Boundary-shukkatest DELETE_FAILED'].join(
    '\n',
  );
  const r = withStubs('teardown', { aws: stackStub, stacks });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /teardown: clean/);
  const bucket = 'cdk-shukkatest-assets-123456789012-us-east-1';
  const at = (pred: (c: string[]) => boolean) => r.calls.findIndex(pred);
  const emptied = at((c) => c[1] === 'list-object-versions' && c.includes(bucket));
  const bootstrap = at((c) => c[1] === 'delete-stack' && c.includes('CDKToolkit-shukkatest'));
  const boundary = at((c) => c[1] === 'delete-stack' && c.includes('Shukka-Boundary-shukkatest'));
  const bucketGone = at((c) => c[1] === 'delete-bucket' && c.includes(bucket));
  assert.ok(emptied >= 0 && bootstrap > emptied, 'the assets bucket is emptied before the bootstrap stack is deleted');
  assert.ok(boundary > bootstrap, 'the boundary stack is deleted after the bootstrap stack');
  assert.ok(bucketGone > bootstrap, 'the retained bucket is deleted after its stack');
  assert.ok(!r.calls.some((c) => c[1] === 'delete-stack' && c.includes('CDKToolkit')), 'the default CDKToolkit is never deleted');
});

// GitHub refuses to start a caller of pipeline.yml pinned to an annotated tag ("workflow file issue",
// no jobs): pipeline.yml calls infra.yml and ec2.yml as ./.github/workflows/..., and GitHub resolves
// those nested calls at the tag object, not the commit it points to. The same commit started from a
// branch and from its SHA; rc.2 and rc.3 (annotated) did not. Release tags must be lightweight.
function checkTag(objectType: string | null): { status: number | null; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'shu-9bj16-'));
  try {
    const bin = join(dir, 'bin');
    spawnSync('mkdir', ['-p', bin, join(dir, 'run', 'runs')]);
    // A stub gh answering `gh api repos/<repo>/git/ref/tags/<tag> --jq .object.type`.
    const answer = objectType === null ? 'echo "gh: Not Found (HTTP 404)" >&2; exit 1' : `printf '%s\\n' '${objectType}'`;
    writeFileSync(
      join(bin, 'gh'),
      `#!/usr/bin/env bash\n[[ "$1 $2" == "api repos/rummykhan/shukka/git/ref/tags/v1.0.0-rc.9" ]] || { echo "unexpected gh $*" >&2; exit 3; }\n${answer}\n`,
    );
    chmodSync(join(bin, 'gh'), 0o755);
    const r = spawnSync('bash', ['-c', `set -uo pipefail; source "${lib}/common.sh"; source "${lib}/setup.sh"; RC_TAG=v1.0.0-rc.9; setup_check_tag`], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RUN_DIR: join(dir, 'run') },
    });
    return { status: r.status, stderr: r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('shu-9bj.16: acceptance refuses an annotated release tag, which GitHub will not start pipeline.yml from', () => {
  const r = checkTag('tag');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /v1\.0\.0-rc\.9 is an annotated tag/);
  assert.match(r.stderr, /lightweight/);
});

test('shu-9bj.16: acceptance accepts a lightweight release tag', () => {
  const r = checkTag('commit');
  assert.equal(r.status, 0, r.stderr);
});

test('shu-9bj.16: acceptance stops on a release tag that does not exist', () => {
  const r = checkTag(null);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /tag v1\.0\.0-rc\.9 does not exist/);
});

test('shu-9bj.16: pipeline.yml calls its nested workflows by ./ path, and the README says release tags are lightweight', () => {
  // The nested ./ calls are why the tag kind matters; if they ever go, this pin can go with them.
  const pipeline = readFileSync(resolve(import.meta.dirname, '..', '.github', 'workflows', 'pipeline.yml'), 'utf8');
  assert.match(pipeline, /uses: \.\/\.github\/workflows\/infra\.yml/);
  const readme = readFileSync(resolve(import.meta.dirname, '..', 'README.md'), 'utf8');
  assert.match(readme, /lightweight tags/);
  assert.match(readme, /annotated tag/);
});

// A stub gh for the test consumer's caller workflow (CI, .github/workflows/ci.yml, id 42) and its runs.
// WF_STATE is the caller's state before it is enabled; ENABLE_RC is what `gh workflow enable` exits with;
// once enabled, the caller turns active on the ACTIVE_AFTER-th look at it (never, if unset). Runs for the
// commit come from $STUB_DIR/runs (a `gh run list --json` array). Every call goes to $STUB_DIR/gh.log.
const ciStub = `#!/usr/bin/env bash
d=$STUB_DIR
printf 'gh %s\\n' "$*" >>"$d/gh.log"
q=
prev=
for a in "$@"; do
  if [[ "$prev" == -q || "$prev" == --jq ]]; then q=$a; fi
  prev=$a
done
out() { if [[ -n "$q" ]]; then jq -rc "$q"; else cat; fi; }
case "$1 $2" in
  "workflow enable")
    [[ "\${ENABLE_RC:-0}" == 0 ]] || { echo "HTTP 403: Resource not accessible by integration" >&2; exit "$ENABLE_RC"; }
    printf '0\\n' >"$d/polls"; exit 0 ;;
  "api repos/rummykhan/shukka-consumer-test/actions/workflows")
    state=\${WF_STATE:-disabled_manually}
    if [[ -f "$d/polls" ]]; then
      n=$(( $(cat "$d/polls") + 1 )); printf '%s\\n' "$n" >"$d/polls"
      if [[ -n "\${ACTIVE_AFTER:-}" ]] && (( n >= ACTIVE_AFTER )); then state=active; fi
    fi
    printf '{"total_count":2,"workflows":[{"id":7,"name":"shukkatest-probe","path":".github/workflows/shukkatest-probe.yml","state":"active"},{"id":42,"name":"CI","path":".github/workflows/ci.yml","state":"%s"}]}\\n' "$state" | out
    exit 0 ;;
  "run list") { cat "$d/runs" 2>/dev/null || printf '[]\\n'; } | out; exit 0 ;;
  "run view") printf '{"status":"completed","conclusion":"startup_failure"}\\n' | out; exit 0 ;;
esac
exit 0
`;

const SHA = 'f275c12a0b1c2d3e4f5061728394a5b6c7d8e9f0';

function withGh(
  script: string,
  env: Record<string, string> = {},
  runs?: unknown[],
): { status: number | null; stdout: string; stderr: string; gh: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'shu-9bj17-'));
  try {
    const bin = join(dir, 'bin');
    spawnSync('mkdir', ['-p', bin, join(dir, 'run', 'runs')]);
    writeFileSync(join(bin, 'gh'), ciStub);
    writeFileSync(join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');
    for (const f of ['gh', 'sleep']) chmodSync(join(bin, f), 0o755);
    writeFileSync(join(dir, 'gh.log'), '');
    if (runs) writeFileSync(join(dir, 'runs'), JSON.stringify(runs));
    // The consumer working copy and its push are stubbed: c_git only records what it was asked to do.
    const fakes = `clean_consumer_github() { :; }; require_consumer_remote() { :; }; commit_all() { printf '%s\\n' ${SHA}; }; c_git() { printf 'gh-stub-git %s\\n' "$*" >>"$STUB_DIR/gh.log"; if [[ "$1" == rev-parse ]]; then printf '%s\\n' ${SHA}; fi; }`;
    const r = spawnSync(
      'bash',
      ['-c', `set -uo pipefail; source "${lib}/common.sh"; source "${lib}/setup.sh"; ${fakes}; ${script}`],
      {
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, STUB_DIR: dir, RUN_DIR: join(dir, 'run'), RUN_ID: '20261123050000', ...env },
      },
    );
    const gh = readFileSync(join(dir, 'gh.log'), 'utf8')
      .split('\n')
      .filter((l) => l !== '');
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, gh };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const pushed = (gh: string[]) => gh.findIndex((l) => l.startsWith('gh-stub-git push'));
const startupFailureRun = {
  databaseId: 45117994300,
  workflowName: '.github/workflows/ci.yml',
  workflowDatabaseId: 42,
  event: 'push',
  createdAt: '2026-11-23T05:00:00Z',
  headBranch: 'main',
};

test('shu-9bj.17: setup dies, and does not push, when enabling the caller fails', () => {
  const r = withGh('setup_push_baseline', { ENABLE_RC: '1' });
  assert.notEqual(r.status, 0);
  assert.ok(r.gh.some((l) => l.startsWith('gh workflow enable CI')), 'gh workflow enable was called');
  assert.match(r.stderr, /ERROR: cannot enable the caller workflow 'CI'/);
  assert.equal(pushed(r.gh), -1, 'nothing was pushed');
});

test('shu-9bj.17: setup dies after a bounded wait, and does not push, when the caller stays disabled', () => {
  const r = withGh('setup_push_baseline');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /ERROR: caller workflow 'CI' is still 'disabled_manually'/);
  assert.equal(pushed(r.gh), -1, 'nothing was pushed');
  const looks = r.gh.filter((l) => l.startsWith('gh api repos/rummykhan/shukka-consumer-test/actions/workflows')).length;
  assert.ok(looks > 2 && looks <= 20, `polled a bounded number of times (${looks})`);
});

test('shu-9bj.17: setup pushes only after gh reports the caller active, and finds a startup-failure run by its file path', () => {
  const r = withGh('setup_push_baseline; cat "$RUN_DIR/state.env"', { ACTIVE_AFTER: '3' }, [startupFailureRun]);
  assert.equal(r.status, 0, r.stderr);
  const enable = r.gh.findIndex((l) => l.startsWith('gh workflow enable CI'));
  const p = pushed(r.gh);
  assert.ok(enable >= 0 && p > enable, 'the push comes after the enable');
  const looksBeforePush = r.gh.slice(enable, p).filter((l) => l.includes('/actions/workflows')).length;
  assert.equal(looksBeforePush, 3, 'it waited until the third look reported active');
  assert.match(r.stdout, /baseline_run=45117994300/);
  assert.match(r.stderr, /named '\.github\/workflows\/ci\.yml'/);
  assert.match(r.stderr, /finished: startup_failure/);
});

test('shu-9bj.17: setup does not re-enable a caller that is already active', () => {
  const r = withGh('setup_push_baseline', { WF_STATE: 'active' }, [startupFailureRun]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.gh.some((l) => l.startsWith('gh workflow enable')), 'no enable call');
  assert.ok(pushed(r.gh) >= 0, 'pushed');
});

test('shu-9bj.17: the wait for a commit finds a run named by the workflow file path and says so; other workflows are not matched', () => {
  const probe = { ...startupFailureRun, databaseId: 1, workflowName: 'shukkatest-probe', workflowDatabaseId: 7, createdAt: '2026-11-23T06:00:00Z' };
  const r = withGh(`wait_run_for_sha ${SHA} CI push`, { WF_STATE: 'active' }, [startupFailureRun, probe]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '45117994300');
  assert.match(r.stderr, /run 45117994300 for f275c12a0b1c is named '\.github\/workflows\/ci\.yml', not 'CI'/);
  assert.match(r.stderr, /startup failure/);
  const none = withGh(`wait_run_for_sha ${SHA} CI push "" 0`, { WF_STATE: 'active' }, [probe]);
  assert.notEqual(none.status, 0, 'a run of another workflow is not the caller run');
});

test('shu-9bj.17: when no run appears, the error names the caller state and the full sha', () => {
  const r = withGh(`wait_run_for_sha ${SHA} CI push "" 0`, { WF_STATE: 'disabled_inactivity' }, []);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, new RegExp(`no 'CI' run for push at ${SHA}`));
  assert.match(r.stderr, /caller 'CI' is disabled_inactivity/);
  const s = withGh('setup_push_baseline', { ACTIVE_AFTER: '1', RUN_APPEAR_TIMEOUT: '0' }, []);
  assert.notEqual(s.status, 0);
  assert.match(s.stderr, new RegExp(`ERROR: no CI run for the baseline merge ${SHA}.*caller 'CI' is active`));
});

// A stub gh whose workflows live in $STUB_DIR/workflows.json (the actions/workflows response). Enabling a
// workflow (by id or name) turns it active there, unless ENABLE_RC is set (the enable fails) or STUCK is set (gh
// accepts the enable but the workflow never turns active).
const probeStub = `#!/usr/bin/env bash
d=$STUB_DIR
printf 'gh %s\\n' "$*" >>"$d/gh.log"
q=
prev=
for a in "$@"; do
  if [[ "$prev" == -q || "$prev" == --jq ]]; then q=$a; fi
  prev=$a
done
out() { if [[ -n "$q" ]]; then jq -rc "$q"; else cat; fi; }
case "$1 $2" in
  "workflow enable")
    [[ "\${ENABLE_RC:-0}" == 0 ]] || { echo "HTTP 403" >&2; exit 1; }
    if [[ -z "\${STUCK:-}" ]]; then
      jq --arg i "$3" '.workflows |= map(if (.id | tostring) == $i or .name == $i then .state = "active" else . end)' "$d/workflows.json" >"$d/w.new" && mv "$d/w.new" "$d/workflows.json"
    fi
    exit 0 ;;
  "api repos/rummykhan/shukka-consumer-test/actions/workflows") out <"$d/workflows.json"; exit 0 ;;
  "run list") printf '[]\\n' | out; exit 0 ;;
esac
exit 0
`;

const consumerWorkflows = {
  total_count: 4,
  workflows: [
    { id: 42, name: 'CI', path: '.github/workflows/ci.yml', state: 'disabled_manually' },
    { id: 7, name: 'shukkatest-probe', path: '.github/workflows/shukkatest-probe.yml', state: 'disabled_manually' },
    { id: 8, name: 'shukkatest-probe-infra', path: '.github/workflows/shukkatest-probe-infra.yml', state: 'disabled_manually' },
    { id: 9, name: 'shukkatest-probe-old', path: '.github/workflows/old.yml', state: 'active' },
  ],
};

function withProbes(script: string, env: Record<string, string> = {}): { status: number | null; stderr: string; gh: string[]; workflows: typeof consumerWorkflows } {
  const dir = mkdtempSync(join(tmpdir(), 'shu-9bj17p-'));
  try {
    const bin = join(dir, 'bin');
    spawnSync('mkdir', ['-p', bin, join(dir, 'run', 'runs'), join(dir, 'run', 'consumer', '.github', 'workflows'), join(dir, 'run', 'consumer', 'probe', 'workflows')]);
    writeFileSync(join(dir, 'run', 'consumer', 'probe', 'workflows', 'shukkatest-probe.yml'), 'name: shukkatest-probe\n');
    writeFileSync(join(bin, 'gh'), probeStub);
    writeFileSync(join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');
    for (const f of ['gh', 'sleep']) chmodSync(join(bin, f), 0o755);
    writeFileSync(join(dir, 'gh.log'), '');
    writeFileSync(join(dir, 'workflows.json'), JSON.stringify(consumerWorkflows));
    const fakes = `commit_all() { printf '%s\\n' ${SHA}; }; c_git() { printf 'gh-stub-git %s\\n' "$*" >>"$STUB_DIR/gh.log"; }; push_main() { c_git push origin HEAD:main; }`;
    const phases = resolve(lib, '..', 'phases');
    const r = spawnSync(
      'bash',
      ['-c', `set -uo pipefail; source "${lib}/common.sh"; source "${phases}/C-own-workflow-on-main.sh"; source "${phases}/J-cli.sh"; ${fakes}; ${script}`],
      {
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, STUB_DIR: dir, RUN_DIR: join(dir, 'run'), RUN_ID: '20261123050000', RUN_APPEAR_TIMEOUT: '0', ...env },
      },
    );
    const gh = readFileSync(join(dir, 'gh.log'), 'utf8').split('\n').filter((l) => l !== '');
    const workflows = JSON.parse(readFileSync(join(dir, 'workflows.json'), 'utf8')) as typeof consumerWorkflows;
    return { status: r.status, stderr: r.stderr, gh, workflows };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('shu-9bj.17: phase C enables the disabled probe workflows by id, and waits for them, before it pushes the probe', () => {
  const r = withProbes('phase_C');
  const enables = r.gh.map((l, k) => [l, k] as const).filter(([l]) => l.startsWith('gh workflow enable'));
  assert.deepEqual(enables.map(([l]) => l.split(' ')[3]).sort(), ['7', '8'], 'only the disabled probes, never the caller or an active one');
  const p = r.gh.findIndex((l) => l.startsWith('gh-stub-git push'));
  assert.ok(p > Math.max(...enables.map(([, k]) => k)), 'the push comes after the enables');
  assert.match(r.stderr, /probe workflows are active/);
  assert.deepEqual(r.workflows.workflows.filter((w) => w.state !== 'active').map((w) => w.name), ['CI']);
});

test('shu-9bj.17: phase C fails, and does not push, when a probe workflow cannot be enabled or never turns active', () => {
  const cases: Record<string, string>[] = [{ ENABLE_RC: '1' }, { STUCK: '1' }];
  for (const env of cases) {
    const r = withProbes('phase_C', env);
    assert.notEqual(r.status, 0, JSON.stringify(env));
    assert.match(r.stderr, env.STUCK ? /probe workflows still not active.*shukkatest-probe/ : /cannot enable the probe workflow 'shukkatest-probe/);
    assert.equal(r.gh.findIndex((l) => l.startsWith('gh-stub-git push')), -1, `no push (${JSON.stringify(env)})`);
  }
});

test('shu-9bj.17: phase B enables the probe workflows before its first push, and phase J re-enables the caller through enable_workflow', () => {
  const b = readFileSync(resolve(lib, '..', 'phases', 'B-pull-request.sh'), 'utf8');
  const enable = b.indexOf('enable_probe_workflows');
  assert.ok(enable > 0 && enable < b.indexOf('c_git push'), 'B enables the probes before it pushes them');
  const r = withProbes('enable_workflow "$CALLER_WORKFLOW" && echo enabled');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.gh.includes('gh workflow enable CI -R rummykhan/shukka-consumer-test'));
  const j = readFileSync(resolve(lib, '..', 'phases', 'J-cli.sh'), 'utf8');
  assert.match(j, /enable_workflow "\$CALLER_WORKFLOW" && state_set workflow_disabled 0/);
  assert.doesNotMatch(j, /gh workflow enable/);
});

// A stub aws for delete_stack's waits: $STUB_DIR/stacks holds "name status" lines; a stack whose status
// is an *_IN_PROGRESS other than REVIEW_IN_PROGRESS settles to UPDATE_COMPLETE on the third
// describe-stacks. Every sleep is logged, so a wait shows up in $STUB_DIR/aws.log as a "sleep" line.
const settlingStub = `#!/usr/bin/env bash
log="$STUB_DIR/aws.log"
st="$STUB_DIR/stacks"
( IFS=$'\\x1f'; printf '%s\\n' "$*" ) >>"$log"
arg() { local k=$1; shift; while (($#)); do [[ "$1" == "$k" ]] && { printf '%s' "$2"; return; }; shift; done; }
name=$(arg --stack-name "$@")
status_of() { awk -v n="$1" '$1 == n && $2 != "DELETE_COMPLETE" {print $2}' "$st"; }
set_status() { awk -v n="$1" -v s="$2" '$1 == n {$2 = s} {print}' "$st" >"$st.new" && mv "$st.new" "$st"; }
case "$1 $2" in
  "sts get-caller-identity") printf '123456789012\\n'; exit 0 ;;
  "cloudformation list-stacks") awk '$2 != "DELETE_COMPLETE" {print $1}' "$st" | paste -sd '\\t' -; exit 0 ;;
  "cloudformation describe-stacks")
    s=$(status_of "$name"); [[ -n "$s" ]] || { echo "Stack with id $name does not exist" >&2; exit 254; }
    n=$(( $(cat "$STUB_DIR/describes" 2>/dev/null || echo 0) + 1 )); echo "$n" >"$STUB_DIR/describes"
    if [[ "$s" == *_IN_PROGRESS && "$s" != REVIEW_IN_PROGRESS && "$s" != DELETE_IN_PROGRESS && $n -ge 3 ]]; then
      s=UPDATE_COMPLETE; set_status "$name" "$s"
    fi
    printf '%s\\n' "$s"; exit 0 ;;
  "cloudformation delete-stack") set_status "$name" DELETE_COMPLETE; exit 0 ;;
esac
for a in "$@"; do
  if [[ "$a" == text ]]; then printf 'None\\n'; exit 0; fi
done
exit 0
`;
const loggingSleep = 'sleep() { printf "sleep\\x1f%s\\n" "$*" >>"$STUB_DIR/aws.log"; }; ';

test('shu-9bj.19: a stack in REVIEW_IN_PROGRESS is deleted on the first attempt with no wait', () => {
  const r = withStubs(`${loggingSleep}delete_stack Shukkatest-Escape`, {
    aws: settlingStub,
    stacks: 'Shukkatest-Escape REVIEW_IN_PROGRESS',
  });
  assert.equal(r.status, 0, r.stderr);
  const del = r.calls.findIndex((c) => c[1] === 'delete-stack' && c.includes('Shukkatest-Escape'));
  assert.ok(del >= 0, 'delete-stack was called');
  assert.deepEqual(
    r.calls.slice(0, del).filter((c) => c[0] === 'sleep'),
    [],
    'no sleep before the delete',
  );
  assert.equal(r.calls.filter((c) => c[1] === 'delete-stack').length, 1, 'one delete attempt');
  assert.match(r.stderr, /Shukkatest-Escape \(REVIEW_IN_PROGRESS\), delete attempt 1/);
});

test('shu-9bj.19: a stack in another *_IN_PROGRESS state is still waited out before it is deleted', () => {
  const r = withStubs(`${loggingSleep}delete_stack Shukkatest-Box`, {
    aws: settlingStub,
    stacks: 'Shukkatest-Box UPDATE_IN_PROGRESS',
  });
  assert.equal(r.status, 0, r.stderr);
  const del = r.calls.findIndex((c) => c[1] === 'delete-stack' && c.includes('Shukkatest-Box'));
  assert.ok(del >= 0, 'delete-stack was called');
  const before = r.calls.slice(0, del);
  assert.equal(before.filter((c) => c[1] === 'describe-stacks').length, 4, 'polled until it settled, then read its status');
  assert.deepEqual(
    before.filter((c) => c[0] === 'sleep'),
    [['sleep', '20'], ['sleep', '20']],
    'waited at the usual 20s interval while it was in progress',
  );
  assert.match(r.stderr, /Shukkatest-Box \(UPDATE_COMPLETE\), delete attempt 1/);
});

// shu-9bj.21: phase D's state, the escape restore, the DELETE_FAILED retry, stale tagged ARNs, need_state
// failures in command substitutions, and the rollback cases' release-line guard.

const phasesDir = resolve(lib, '..', 'phases');
const casesDir = resolve(lib, '..', 'cases');

function stateLines(dir: string): string[] {
  return readFileSync(join(dir, 'run', 'state.env'), 'utf8').split('\n').filter((l) => l !== '');
}

test('shu-9bj.21: state_set flattens a multi-line value (raw CLI error output) into one line instead of dying', () => {
  const r = withStubs(
    `state_set standin_bucket_policy $'\\nAn error occurred (NoSuchBucketPolicy) when calling the GetBucketPolicy operation\\r\\n\\nThe bucket policy does not exist\\n'; state_set plain 'a  b '; echo after; cat "$RUN_DIR/state.env"`,
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^after$/m, 'state_set did not stop the shell');
  assert.deepEqual(r.stdout.split('\n').filter((l) => l.includes('=')), [
    'standin_bucket_policy=An error occurred (NoSuchBucketPolicy) when calling the GetBucketPolicy operation The bucket policy does not exist',
    'plain=a  b ',
  ]);
});

// A stub aws for phase D: the stand-in bucket has no policy and the queue does not exist, and the CLI
// says so on stderr the way it does, starting with a blank line.
const fenceStub = `#!/usr/bin/env bash
( IFS=$'\\x1f'; printf '%s\\n' "$*" ) >>"$STUB_DIR/aws.log"
case "$1 $2" in
  "s3api get-bucket-policy") printf '\\nAn error occurred (NoSuchBucketPolicy) when calling the GetBucketPolicy operation: The bucket policy does not exist\\n' >&2; exit 254 ;;
  "sqs get-queue-url") printf '\\nAn error occurred (AWS.SimpleQueueService.NonExistentQueue) when calling the GetQueueUrl operation:\\nThe specified queue does not exist.\\n' >&2; exit 254 ;;
esac
exit 0
`;

/** Runs phase D against a real local git consumer (with a bare origin) and stubbed aws, CI waits and box. */
function runPhaseD(boxRun: string): { status: number | null; stderr: string; state: string[]; calls: string; log: string[]; settings: unknown } {
  const dir = mkdtempSync(join(tmpdir(), 'shu-9bj21d-'));
  try {
    const bin = join(dir, 'bin');
    const consumer = join(dir, 'run', 'consumer');
    spawnSync('mkdir', ['-p', bin, join(dir, 'run', 'runs'), join(consumer, 'infra')]);
    writeFileSync(join(bin, 'aws'), fenceStub);
    writeFileSync(join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');
    for (const f of ['aws', 'sleep']) chmodSync(join(bin, f), 0o755);
    writeFileSync(join(dir, 'aws.log'), '');
    writeFileSync(join(dir, 'calls'), '');
    writeFileSync(join(dir, 'escape'), 'ROLLBACK_FAILED\n');
    writeFileSync(join(consumer, 'infra', 'settings.json'), '{ "escape": false }\n');
    const git = (cwd: string, ...a: string[]) => {
      const g = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd, encoding: 'utf8' });
      assert.equal(g.status, 0, g.stderr);
    };
    git(dir, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
    git(consumer, 'init', '-q', '-b', 'main');
    git(consumer, 'add', '-A');
    git(consumer, 'commit', '-q', '-m', 'baseline');
    git(consumer, 'remote', 'add', 'origin', join(dir, 'origin.git'));
    git(consumer, 'push', '-q', '-u', 'origin', 'main');
    const fakes = [
      'snapshot() { :; }',
      'stack_last_updated() { echo 2026-11-23T10:00:00Z; }',
      'stack_status() { if [[ "$1" == Shukkatest-Escape ]]; then cat "$STUB_DIR/escape"; else echo CREATE_COMPLETE; fi; }',
      'delete_stack() { echo "delete_stack $1" >>"$STUB_DIR/calls"; echo ABSENT >"$STUB_DIR/escape"; }',
      'wait_run_of() { echo "wait_run_of $1" >>"$STUB_DIR/calls"; echo "run-${1:0:7}"; }',
      'push_main() { echo "push" >>"$STUB_DIR/calls"; c_git push -q origin HEAD:main; }',
      'c_git() { git -C "$RUN_DIR/consumer" -c user.name=t -c user.email=t@example.com "$@"; }',
      `box_run() { ${boxRun}; }`,
      'state_set standin_stack Standin-shukkatest-x; state_set standin_bucket standin-shukkatest-x-1; state_set standin_table standin-shukkatest-x',
    ].join('\n');
    const r = spawnSync('bash', ['-c', `set -uo pipefail; source "${lib}/common.sh"; source "${phasesDir}/D-fence.sh"\n${fakes}\nphase_D`], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, STUB_DIR: dir, RUN_DIR: join(dir, 'run'), RUN_ID: '20261123100000', AWS_PROFILE: 'stub' },
    });
    const log = spawnSync('git', ['log', '--format=%s', 'main'], { cwd: join(dir, 'origin.git'), encoding: 'utf8' }).stdout.split('\n').filter((l) => l);
    return {
      status: r.status,
      stderr: r.stderr,
      state: stateLines(dir),
      calls: readFileSync(join(dir, 'calls'), 'utf8'),
      log,
      settings: JSON.parse(readFileSync(join(consumer, 'infra', 'settings.json'), 'utf8')),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('shu-9bj.21: phase D stores the stand-in bucket policy and queue answers as single lines and runs the restore merge', () => {
  const r = runPhaseD('echo AccessDenied');
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /value has a newline|ERROR/);
  const get = (k: string) => r.state.filter((l) => l.startsWith(`${k}=`)).at(-1)?.slice(k.length + 1);
  assert.match(get('standin_bucket_policy') ?? '', /^An error occurred \(NoSuchBucketPolicy\)/);
  assert.match(get('standin_queue') ?? '', /NonExistentQueue.*does not exist/);
  assert.ok(get('escape_restore_run'), 'the restore merge ran and its run was recorded');
  assert.deepEqual(r.log, ['shukkatest 20261123100000: remove the escape attempt', 'shukkatest 20261123100000: escape attempt (fence check)', 'baseline']);
  assert.match(r.calls, /delete_stack Shukkatest-Escape/);
});

test('shu-9bj.21: phase D still merges the escape removal and deletes Shukkatest-Escape after the escape part dies', () => {
  const r = runPhaseD('die "box unreachable"');
  assert.notEqual(r.status, 0, 'the phase reports the failure');
  assert.match(r.stderr, /ERROR: box unreachable/);
  assert.equal(r.log[0], 'shukkatest 20261123100000: remove the escape attempt', 'the restore commit reached main');
  assert.deepEqual(r.settings, { escape: false });
  assert.ok(r.state.some((l) => l.startsWith('escape_restore_run=')), 'the restore run was recorded');
  const calls = r.calls.split('\n');
  assert.ok(calls.indexOf('delete_stack Shukkatest-Escape') > calls.lastIndexOf('push'), 'Shukkatest-Escape is deleted after the restore merge');
});

test('shu-9bj.21: other phases pass no raw multi-line CLI or HTTP output to state_set', () => {
  for (const f of ['D-fence.sh', 'G-rollback.sh']) {
    const src = readFileSync(join(phasesDir, f), 'utf8');
    const raw = src.split('\n').filter((l) => /state_set .*(2>&1|http_get)/.test(l) && !/one_line/.test(l));
    assert.deepEqual(raw, [], f);
  }
});

// A stub aws for the DELETE_FAILED retry: Shukkatest-Escape's plain delete fails on StandinBucketPolicy
// (the execution role may not delete it; its creation was cancelled); a delete that retains it succeeds.
const retainStub = `#!/usr/bin/env bash
log="$STUB_DIR/aws.log"
st="$STUB_DIR/stacks"
( IFS=$'\\x1f'; printf '%s\\n' "$*" ) >>"$log"
arg() { local k=$1; shift; while (($#)); do [[ "$1" == "$k" ]] && { printf '%s' "$2"; return; }; shift; done; }
name=$(arg --stack-name "$@")
status_of() { awk -v n="$1" '$1 == n && $2 != "DELETE_COMPLETE" {print $2}' "$st"; }
set_status() { awk -v n="$1" -v s="$2" '$1 == n {$2 = s} {print}' "$st" >"$st.new" && mv "$st.new" "$st"; }
case "$1 $2" in
  "sts get-caller-identity") printf '123456789012\\n'; exit 0 ;;
  "cloudformation list-stacks") awk '$2 != "DELETE_COMPLETE" {print $1}' "$st" | paste -sd '\\t' -; exit 0 ;;
  "cloudformation describe-stacks")
    s=$(status_of "$name"); [[ -n "$s" ]] || { echo "Stack with id $name does not exist" >&2; exit 254; }
    printf '%s\\n' "$s"; exit 0 ;;
  "cloudformation describe-stack-resources")
    if [[ "$name" == Shukkatest-Escape && "$(status_of "$name")" == DELETE_FAILED && "$*" == *DELETE_FAILED* ]]; then
      printf 'StandinBucketPolicy\\tStandinQueue\\n'; exit 0
    fi ;;
  "cloudformation delete-stack")
    if [[ "$name" == Shukkatest-Escape && "$*" != *--retain-resources* ]]; then set_status "$name" DELETE_FAILED; else set_status "$name" DELETE_COMPLETE; fi
    exit 0 ;;
esac
for a in "$@"; do
  if [[ "$a" == text ]]; then printf 'None\\n'; exit 0; fi
done
exit 0
`;

test('shu-9bj.21: delete_stack retries a DELETE_FAILED stack once with --retain-resources for the failed logical ids', () => {
  const r = withStubs('delete_stack Shukkatest-Escape', { aws: retainStub, stacks: 'Shukkatest-Escape ROLLBACK_FAILED' });
  assert.equal(r.status, 0, r.stderr);
  const deletes = r.calls.filter((c) => c[1] === 'delete-stack');
  assert.deepEqual(deletes, [
    ['cloudformation', 'delete-stack', '--stack-name', 'Shukkatest-Escape'],
    ['cloudformation', 'delete-stack', '--stack-name', 'Shukkatest-Escape', '--retain-resources', 'StandinBucketPolicy', 'StandinQueue'],
  ]);
  assert.match(r.stderr, /retaining StandinBucketPolicy StandinQueue/);
});

test('shu-9bj.21: teardown gets Shukkatest-Escape out by retaining its failed resources, then goes on to delete the bootstrap', () => {
  const stacks = ['Shukkatest-Escape ROLLBACK_FAILED', 'CDKToolkit-shukkatest CREATE_COMPLETE', 'Shukka-Boundary-shukkatest CREATE_COMPLETE'].join('\n');
  const r = withStubs('teardown', { aws: retainStub, stacks });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /teardown: clean/);
  assert.doesNotMatch(r.stderr, /leaving the shukkatest bootstrap in place/);
  const at = (pred: (c: string[]) => boolean) => r.calls.findIndex(pred);
  const retained = at((c) => c[1] === 'delete-stack' && c.includes('Shukkatest-Escape') && c.includes('--retain-resources'));
  const bootstrap = at((c) => c[1] === 'delete-stack' && c.includes('CDKToolkit-shukkatest'));
  const boundary = at((c) => c[1] === 'delete-stack' && c.includes('Shukka-Boundary-shukkatest'));
  assert.ok(retained >= 0 && bootstrap > retained && boundary > bootstrap, 'escape (retained), then bootstrap, then boundary');
  assert.equal(r.calls.filter((c) => c[1] === 'delete-stack' && c.includes('--retain-resources')).length, 1, 'retained once');
});

// A stub aws whose tagging API still lists a deleted ENI and volume next to a live volume and a volume
// whose describe is denied (reported: only "not found" counts as gone).
const taggedStub = `#!/usr/bin/env bash
( IFS=$'\\x1f'; printf '%s\\n' "$*" ) >>"$STUB_DIR/aws.log"
a="arn:aws:ec2:us-east-1:123456789012"
case "$1 $2" in
  "sts get-caller-identity") printf '123456789012\\n'; exit 0 ;;
  "resourcegroupstaggingapi get-resources")
    printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "$a:network-interface/eni-gone" "$a:volume/vol-gone" "$a:volume/vol-live" "$a:volume/vol-denied" "$a:elastic-ip/eipalloc-1"; exit 0 ;;
  "ec2 describe-network-interfaces") echo "An error occurred (InvalidNetworkInterfaceID.NotFound) when calling the DescribeNetworkInterfaces operation: The networkInterface ID 'eni-gone' does not exist" >&2; exit 254 ;;
  "ec2 describe-volumes")
    case "$*" in
      *vol-gone*) echo "An error occurred (InvalidVolume.NotFound) when calling the DescribeVolumes operation: The volume 'vol-gone' does not exist." >&2; exit 254 ;;
      *vol-denied*) echo "An error occurred (UnauthorizedOperation) when calling the DescribeVolumes operation" >&2; exit 254 ;;
      *) printf '{"Volumes":[{"VolumeId":"vol-live"}]}\\n'; exit 0 ;;
    esac ;;
esac
for a in "$@"; do
  if [[ "$a" == text ]]; then printf 'None\\n'; exit 0; fi
done
exit 0
`;

test('shu-9bj.21: leftovers describes each tagged ARN and reports only those that still exist', () => {
  const r = withStubs('leftovers', { aws: taggedStub });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(lines(r.stdout), [
    'LEFTOVER tagged arn:aws:ec2:us-east-1:123456789012:elastic-ip/eipalloc-1',
    'LEFTOVER tagged arn:aws:ec2:us-east-1:123456789012:volume/vol-denied',
    'LEFTOVER tagged arn:aws:ec2:us-east-1:123456789012:volume/vol-live',
  ]);
  assert.ok(r.calls.some((c) => c[1] === 'describe-network-interfaces' && c.includes('eni-gone')), 'the ENI was described');
});

/** Runs case_exec on a case file written from `body` (the body of case_run), with `pre` run first. */
function runCase(body: string, pre = ''): { status: number | null; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'shu-9bj21c-'));
  try {
    spawnSync('mkdir', ['-p', join(dir, 'run', 'runs')]);
    const f = join(dir, 'case.sh');
    writeFileSync(f, `case_run() {\n${body}\n}\n`);
    const r = spawnSync('bash', ['-c', `set -uo pipefail; source "${lib}/common.sh"; ${pre}\ncase_exec "${f}"`], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, RUN_DIR: join(dir, 'run'), STUB_DIR: dir },
    });
    return { status: r.status, stderr: r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('shu-9bj.21: a missing state value fails the case, whether need_state ran in an assignment or inside an assertion', () => {
  const assigned = runCase('  local run\n  run=$(need_state escape_restore_run) || return\n  ok "never reached"');
  assert.notEqual(assigned.status, 0, assigned.stderr);
  assert.match(assigned.stderr, /state 'escape_restore_run' is missing/);
  const inline = runCase('  assert_match "x$(need_state standin_queue)" "x" "a check that would pass on an empty value"');
  assert.notEqual(inline.status, 0, inline.stderr);
  const present = runCase('  assert_eq "$(need_state k)" v "present"', 'state_set k v');
  assert.equal(present.status, 0, present.stderr);
  const direct = runCase('  fail "direct"');
  assert.notEqual(direct.status, 0);
  const runSh = readFileSync(resolve(lib, '..', 'run.sh'), 'utf8');
  assert.match(runSh, /if case_exec "\$f"; then verdict=PASS; else verdict=FAIL; fi/);
});

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const rollbackState = `state_set unhealthy_run 77; state_set unhealthy_sha ${NEW}; state_set before_unhealthy_web_rev ${OLD}; state_set after_unhealthy_web_rev ${OLD}; state_set after_unhealthy_http "200 ${OLD}"; state_set before_unhealthy_api_rev c; state_set after_unhealthy_api_rev c; state_set after_restore_api_rev c; state_set before_unhealthy_api_unit "1 active"; state_set after_restore_api_unit "1 active"`;
const ciFakes = `run_conclusion() { echo failure; }; job_conclusions() { echo failure; }; did_not_run() { :; }; http_code() { echo 200; }; box_ip() { echo 10.0.0.1; }`;

test('shu-9bj.21: R5 rollback cases fail when no release ran on the box, before comparing current/previous', () => {
  for (const c of ['G01-R5-unhealthy-release-rolls-back.sh', 'G02-R5-other-app-keeps-running.sh']) {
    const body = `  source "${join(casesDir, c)}"; case_run`;
    const noRelease = runCase(body, `${rollbackState}; ${ciFakes}; printf 'shukka / servers / release web\\tskipped: infra deploy failed ${OLD} ${NEW}\\n' >"$RUN_DIR/runs/77.log"`);
    assert.notEqual(noRelease.status, 0, c);
    assert.match(noRelease.stderr, /not ok - the web release of b+ ran on the box and rolled back/, c);
    assert.doesNotMatch(noRelease.stderr, /ok - web current\/REVISION is the previous release|ok - api release unchanged/, c);
    const released = runCase(body, `${rollbackState}; ${ciFakes}; printf 'release web\\tshukka: shukkatest/web ${OLD} -> ${NEW} rolled-back\\n' >"$RUN_DIR/runs/77.log"`);
    assert.equal(released.status, 0, `${c}: ${released.stderr}`);
  }
});

test('shu-9bj.21: the R8 CLI rollback case fails when shukka deploy released nothing, before comparing current/previous', () => {
  const body = `  source "${join(casesDir, 'J04-R8-cli-rolls-back-unhealthy.sh')}"; case_run`;
  const st = `state_set before_cli_unhealthy_web_rev ${OLD}; state_set cli_unhealthy_sha ${NEW}; state_set cli_unhealthy_rc 1; state_set after_cli_unhealthy_web_rev ${OLD}; state_set cli_restore_rc 0`;
  const none = runCase(body, `${st}; printf 'shukka: stacks failed (${OLD} ${NEW})\\n' >"$RUN_DIR/runs/cli-unhealthy.log"`);
  assert.notEqual(none.status, 0);
  assert.match(none.stderr, /not ok - the web release of b+ ran on the box and rolled back \(no release line in the shukka deploy output\)/);
  assert.doesNotMatch(none.stderr, /ok - web current\/REVISION is the previous release/);
  const rolled = runCase(body, `${st}; printf 'shukka: shukkatest/web ${OLD} -> ${NEW} rolled-back\\n' >"$RUN_DIR/runs/cli-unhealthy.log"`);
  assert.equal(rolled.status, 0, rolled.stderr);
});

test('shu-ecn: setup_ci_stack pushes the baseline with the caller disabled, then deploys the CI stack with shukka deploy-ci, never npm ci or npx cdk with the admin profile', () => {
  // Every outside command is a function that logs one line: npm, the shukka CLI, gh, the consumer's git.
  const fakes = [
    'L() { printf \'%s\\n\' "$*" >>"$STUB_DIR/cmds.log"; }',
    'npm() { L "npm $*"; }', 'npx() { L "npx $*"; }', 'shukka() { L "shukka $*"; }', 'gh() { L "gh $*"; }',
    'c_git() { L "git $*"; if [[ "$1" == rev-parse ]]; then echo ' + SHA + '; fi; }',
    'commit_all() { L "commit_all $1"; echo ' + SHA + '; }', 'clean_consumer_github() { L clean; }', 'require_consumer_remote() { :; }',
    'enable_workflow() { L "enable $1"; }', 'wait_run_of() { echo 1; }',
  ].join('; ');
  const cli = resolve(lib, 'cli.sh');
  const r = withStubs(`source "${cli}"; ${fakes}; mkdir -p "$RUN_DIR/consumer/infra"; RUN_ID=1 AWS_REGION=us-east-1 SHUKKA_REPO=x RC_TAG=v1.0.0-rc.1; setup_ci_stack && setup_push_baseline; cat "$STUB_DIR/cmds.log"`);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  const at = (re: RegExp) => lines.findIndex((l) => re.test(l));
  assert.ok(at(/^npm install --package-lock-only --ignore-scripts /) >= 0, 'the lockfile is resolved without install scripts');
  assert.ok(!lines.some((l) => /^npm (ci|install)(?!.*--ignore-scripts)/.test(l) || /^npx /.test(l)), `no npm ci or npx cdk here: ${lines.join(' | ')}`);
  const disable = at(/^gh workflow disable CI /);
  const push = at(/^git push -q --force origin HEAD:main$/);
  const deploy = at(/^shukka deploy-ci shukkatest --profile stub --region us-east-1 --yes$/);
  assert.ok(disable >= 0 && push > disable && deploy > push, `disable, push the baseline, then deploy-ci: ${lines.join(' | ')}`);
  const first = at(/^git commit -q --allow-empty -m shukkatest 1: first merge$/);
  const enable = at(/^enable CI$/);
  const firstPush = at(/^git push -q origin HEAD:main$/);
  assert.ok(first > deploy && enable > first && firstPush > enable, 'the first merge is pushed after the CI stack, with the caller enabled');
});

// shu-9bj.22: the rc.8 run's suite defects: waits that count a laptop's sleep, gh reads that give up on a
// network error, the live page read at case time, smoke without dig, a fix commit that changes nothing
// live, release commands by a first page of list-commands, and box reads told apart by line number.

const acceptDir = resolve(lib, '..');

/** Runs a script with common.sh sourced and the given executables (name → body) first on PATH. */
function withBin(script: string, bins: Record<string, string>, env: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string; dir: string; read: (f: string) => string } {
  const dir = mkdtempSync(join(tmpdir(), 'shu-9bj22-'));
  const bin = join(dir, 'bin');
  spawnSync('mkdir', ['-p', bin, join(dir, 'run', 'runs')]);
  for (const [name, body] of Object.entries({ sleep: '#!/usr/bin/env bash\nexit 0\n', ...bins })) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  const r = spawnSync('bash', ['-c', `set -uo pipefail; source "${lib}/common.sh"\n${script}`], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, STUB_DIR: dir, RUN_DIR: join(dir, 'run'), AWS_PROFILE: 'stub', ...env },
  });
  const read = (f: string) => {
    try {
      return readFileSync(join(dir, f), 'utf8');
    } catch {
      return '';
    }
  };
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, dir, read };
}

// A date whose +%s jumps by $STEP seconds on every call (a laptop asleep between every poll).
const jumpingDate = `#!/usr/bin/env bash
if [[ "$1" == +%s ]]; then
  n=$(cat "$STUB_DIR/clock" 2>/dev/null || echo 1000000)
  echo $((n + STEP)) >"$STUB_DIR/clock"; echo "$n"; exit 0
fi
exec /bin/date "$@"
`;

// A gh that answers the workflows listing, and for run list answers from $STUB_DIR/answers, one line per
// call: "neterr" (a network failure), "none" (no run yet), "run" (the run exists).
const runListGh = `#!/usr/bin/env bash
printf '%s\\n' "$*" >>"$STUB_DIR/gh.log"
case "$1 $2" in
  "api repos/rummykhan/shukka-consumer-test/actions/workflows") echo '{"id":7,"name":"CI","state":"active","path":".github/workflows/ci.yml"}'; exit 0 ;;
  "run list")
    n=$(($(cat "$STUB_DIR/n" 2>/dev/null || echo 0) + 1)); echo $n >"$STUB_DIR/n"
    a=$(sed -n "\${n}p" "$STUB_DIR/answers"); a=\${a:-run}
    case "$a" in
      neterr) echo 'error connecting to api.github.com' >&2; echo 'check your internet connection or https://githubstatus.com' >&2; exit 1 ;;
      none) echo '[]'; exit 0 ;;
      run) echo '[{"databaseId":42,"workflowName":"CI","workflowDatabaseId":7,"event":"push","createdAt":"2026-11-24T00:00:00Z","headBranch":"main"}]'; exit 0 ;;
    esac ;;
  "run view") echo 'HTTP 404: Not Found' >&2; exit 1 ;;
esac
exit 0
`;

test('shu-9bj.22: run.sh keeps the Mac awake with caffeinate for as long as the run shell lives', () => {
  const r = withBin('keep_awake; wait; cat "$STUB_DIR/caffeinate.log"; echo "pid $$"', {
    caffeinate: '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" >>"$STUB_DIR/caffeinate.log"\n',
  });
  assert.equal(r.status, 0, r.stderr);
  const pid = /pid (\d+)/.exec(r.stdout)?.[1];
  assert.match(r.stdout, new RegExp(`^-i -s -w ${pid}$`, 'm'), 'caffeinate waits on the run shell itself');
  const src = readFileSync(join(acceptDir, 'run.sh'), 'utf8');
  assert.ok(src.indexOf('\nkeep_awake\n') > 0 && src.indexOf('\nkeep_awake\n') < src.indexOf('setup_preflight\n'), 'run.sh calls keep_awake before any phase');
  const none = withBin('keep_awake; echo done', {}, { PATH: '/bin' });
  assert.match(none.stdout, /done/, 'no caffeinate (Linux) is fine');
  assert.doesNotMatch(none.stderr, /caffeinate/);
});

test('shu-9bj.22: gh reads retry a network error and return the answer; other gh errors are not retried', () => {
  const r = withBin(`printf 'neterr\\nneterr\\nrun\\n' >"$STUB_DIR/answers"; run_for_sha abc CI push`, { gh: runListGh });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '42 CI');
  assert.equal(r.read('n').trim(), '3', 'two network failures, then the answer');
  const notFound = withBin('run_conclusion 99; echo "rc $?"', { gh: runListGh });
  assert.match(notFound.stdout, /rc 1/);
  assert.equal(notFound.read('gh.log').split('\n').filter((l) => l.startsWith('run view')).length, 1, 'a 404 is asked once');
  assert.match(notFound.stderr, /HTTP 404/);
});

test('shu-9bj.22: a run wait does not time out because the machine slept between polls; it still times out after its awake time', () => {
  // Every poll the clock jumps an hour; three empty answers, then the run. Wall clock: 3h > 300s.
  const slept = withBin(`printf 'none\\nnone\\nnone\\nrun\\n' >"$STUB_DIR/answers"; wait_run_for_sha abc CI push`, { gh: runListGh, date: jumpingDate }, { STEP: '3600' });
  assert.equal(slept.status, 0, slept.stderr);
  assert.equal(slept.stdout.trim(), '42');
  // Never a run: the wait ends after about 300s of capped steps (10s interval + 60s slack each).
  const never = withBin(`printf 'none\\n%.0s' {1..50} >"$STUB_DIR/answers"; wait_run_for_sha abc CI push; echo "rc $?"`, { gh: runListGh, date: jumpingDate }, { STEP: '3600' });
  assert.match(never.stdout, /rc 1/);
  assert.match(never.stderr, /no 'CI' run for push at abc after 300s awake/);
  const polls = never.read('gh.log').split('\n').filter((l) => l.includes('databaseId,workflowName')).length;
  assert.equal(polls, 5, '300s of awake time is five polls 70s (capped) apart');
  // wait_until counts the same way.
  const until = withBin(`n=0; f() { n=$((n + 1)); ((n >= 4)); }; wait_until 300 10 f; echo "rc $? n $n"`, { date: jumpingDate }, { STEP: '3600' });
  assert.match(until.stdout, /rc 0 n 4/);
});

test('shu-9bj.22: phase J saves the live page right after the CLI deploy, and the R8 case asserts on the saved page', () => {
  const src = readFileSync(join(phasesDir, 'J-cli.sh'), 'utf8');
  const deploy = src.indexOf('cli_try deploy\n');
  const saved = src.indexOf('state_set after_cli_page "$(http_get "http://$(box_ip):8080/" | one_line)"');
  assert.ok(deploy > 0 && saved > deploy && saved < src.indexOf('cli_try dirty'), 'the page is saved right after cli deploy, before anything else deploys');
  const body = `  source "${join(casesDir, 'J01-R8-cli-deploys-head-without-actions.sh')}"; case_run`;
  // At case time the live address serves a later release; the case must not look at it.
  const live = `http_get() { echo "revision: ${OLD}"; }; box_ip() { echo 10.0.0.1; }`;
  const st = `state_set cli_sha ${NEW}; state_set cli_runs_for_sha 0; state_set cli_deploy_rc 0; state_set after_cli_web_rev ${NEW}`;
  const good = runCase(body, `${live}; ${st}; state_set after_cli_page "shukkatest-web-ok revision: ${NEW}"`);
  assert.equal(good.status, 0, good.stderr);
  const bad = runCase(body, `${live}; ${st}; state_set after_cli_page "shukkatest-web-ok revision: ${OLD}"`);
  assert.notEqual(bad.status, 0);
  const missing = runCase(body, `${live}; ${st}`);
  assert.match(missing.stderr, /state 'after_cli_page' is missing/);
});

/** A tiny DNS server (UDP, 127.0.0.1, any port) that answers every A query with 127.0.0.1. */
const dnsServer = `
const dgram = require('node:dgram');
const s = dgram.createSocket('udp4');
s.on('message', (q, rinfo) => {
  let o = 12; while (q[o] !== 0) o += q[o] + 1; o += 5;
  const head = Buffer.from(q.subarray(0, 12)); head.writeUInt16BE(0x8180, 2); head.writeUInt16BE(1, 6);
  const ans = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 127, 0, 0, 1]);
  s.send(Buffer.concat([head, q.subarray(12, o), ans]), rinfo.port, rinfo.address);
});
s.bind(0, '127.0.0.1', () => console.log(s.address().port));
`;

test('shu-9bj.22: smoke.sh resolves the box at the zone name server with no dig or nslookup on PATH', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shu-9bj22s-'));
  const server = spawn(process.execPath, ['-e', dnsServer]);
  try {
    const [port] = (await once(server.stdout, 'data')) as [Buffer];
    const smoke = join(dir, 'smoke');
    cpSync(join(acceptDir, 'consumer', 'smoke'), smoke, { recursive: true });
    writeFileSync(join(smoke, 'smoke.env'), `ZONE=shukkatest.example\nNS=127.0.0.1:${port.toString().trim()}\n`);
    // PATH: only the tools the smoke test may use, linked one by one; no dig, no nslookup.
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    for (const t of ['bash', 'grep', 'cat', 'dirname', 'tail', 'awk']) {
      const p = ['/bin', '/usr/bin'].map((d) => join(d, t)).find((x) => existsSync(x));
      if (p) symlinkSync(p, join(bin, t));
    }
    symlinkSync(process.execPath, join(bin, 'node'));
    writeFileSync(join(bin, 'curl'), `#!${join(bin, 'bash')}\nprintf '%s\\n' "$*" >>"${join(dir, 'curl.log')}"\ncase "$*" in *8080/health*|*8081/health*) echo ok ;; *) echo 'shukkatest-web-ok' ;; esac\n`);
    chmodSync(join(bin, 'curl'), 0o755);
    const child = spawn(join(bin, 'bash'), [join(smoke, 'smoke.sh')], { env: { PATH: bin } });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const [code] = (await once(child, 'exit')) as [number];
    assert.equal(code, 0, out);
    assert.match(out, /smoke: box\.shukkatest\.example is 127\.0\.0\.1/);
    assert.match(out, /smoke: ok/);
    assert.match(readFileSync(join(dir, 'curl.log'), 'utf8'), /http:\/\/127\.0\.0\.1:8080\/health/);
    const src = readFileSync(join(smoke, 'smoke.sh'), 'utf8');
    assert.doesNotMatch(src.replace(/^#.*$/gm, ''), /\b(dig|nslookup)\b/, 'no dig or nslookup left in the script');
  } finally {
    server.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shu-9bj.22: phase G's fix commit changes web content against what is live after the rollback, so a release must happen", () => {
  const dir = mkdtempSync(join(tmpdir(), 'shu-9bj22g-'));
  try {
    const consumer = join(dir, 'run', 'consumer');
    spawnSync('mkdir', ['-p', join(consumer, 'apps', 'web'), join(dir, 'run', 'runs')]);
    writeFileSync(join(consumer, 'apps', 'web', 'health.json'), '{ "healthy": true }\n');
    writeFileSync(join(consumer, 'apps', 'web', 'page.txt'), 'shukkatest-web-ok\nbaseline\n');
    const git = (...a: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd: consumer, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('commit', '-q', '-m', 'live before the unhealthy release');
    const fakes = 'snapshot() { :; }; push_main() { :; }; wait_run_of() { echo 1; }; box_ip() { echo 10.0.0.1; }; http_code() { echo 500; }; http_get() { echo x; }; c_git() { git -C "$RUN_DIR/consumer" -c user.name=t -c user.email=t@example.com "$@"; }';
    const r = spawnSync('bash', ['-c', `set -uo pipefail; source "${lib}/common.sh"; source "${phasesDir}/G-rollback.sh"; ${fakes}; RUN_ID=20261124; phase_G`], {
      encoding: 'utf8',
      env: { ...process.env, RUN_DIR: join(dir, 'run') },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(git('log', '--format=%s', '-1').stdout.trim(), 'shukkatest 20261124: healthy web release again');
    // The rollback leaves the content of HEAD~2 live; the fix (HEAD) must differ from it under apps/web.
    const d = git('diff', '--name-only', 'HEAD~2', 'HEAD', '--', 'apps/web');
    assert.deepEqual(d.stdout.trim().split('\n'), ['apps/web/page.txt']);
    assert.match(readFileSync(join(consumer, 'apps', 'web', 'page.txt'), 'utf8'), /^shukkatest-web-ok\n/, 'the smoke marker stays');
    assert.equal(readFileSync(join(consumer, 'apps', 'web', 'health.json'), 'utf8'), '{ "healthy": true }\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A stub aws for the release command lookup: the instance, a list-commands answer whose first entries
// are not in time order, and invocation times per command id.
const ssmStub = `#!/usr/bin/env bash
( IFS=$'\\x1f'; printf '%s\\n' "$*" ) >>"$STUB_DIR/aws.log"
arg() { local k=$1; shift; while (($#)); do [[ "$1" == "$k" ]] && { printf '%s' "$2"; return; }; shift; done; }
case "$1 $2" in
  "ec2 describe-instances") echo i-0abc; exit 0 ;;
  "ssm list-commands")
    p='{"commands":["shukka-release.sh --app web --sha ${NEW}"]}'
    echo "{\\"Commands\\":[{\\"CommandId\\":\\"old-1\\",\\"RequestedDateTime\\":\\"2026-11-24T01:00:00.000000+00:00\\",\\"Parameters\\":$p},{\\"CommandId\\":\\"new-2\\",\\"RequestedDateTime\\":\\"2026-11-24T03:00:00.000000+00:00\\",\\"Parameters\\":$p},{\\"CommandId\\":\\"mid-3\\",\\"RequestedDateTime\\":\\"2026-11-24T02:00:00.000000+00:00\\",\\"Parameters\\":$p}]}"; exit 0 ;;
  "ssm get-command-invocation")
    case "$(arg --command-id "$@")" in
      cmd-from-log) printf '2026-11-24T00:00:10.000Z\\t2026-11-24T00:00:20.000Z\\n' ;;
      new-2) printf '2026-11-24T03:00:10.000Z\\t2026-11-24T03:00:20.000Z\\n' ;;
      *) printf '2026-11-24T09:00:00.000Z\\t2026-11-24T09:00:01.000Z\\n' ;;
    esac; exit 0 ;;
esac
exit 0
`;

test('shu-9bj.22: release_command_window takes the command id from the release job log line, else from a fully paged InvokedAfter listing, newest first', () => {
  const logLine = `job_messages() { [[ "$1" == 77 && "$2" == "$JOB_RE_APP" ]] && printf '%s\\n' 'shukka: building web' 'shukka: sent release of shukkatest/web ${NEW} to i-0abc (command cmd-from-log)' 'shukka: shukkatest/web ${OLD} -> ${NEW} ok'; }`;
  const fromLog = withBin(`${logLine}; release_command_window web ${NEW} 77 2026-11-24T00:00:00Z`, { aws: ssmStub });
  assert.equal(fromLog.status, 0, fromLog.stderr);
  const epoch = (s: string) => Date.parse(s) / 1000;
  assert.equal(fromLog.stdout.trim(), `${epoch('2026-11-24T00:00:10Z')} ${epoch('2026-11-24T00:00:20Z')}`);
  assert.doesNotMatch(fromLog.read('aws.log'), /list-commands/, 'no listing when the log names the command');
  // Another app's or commit's line is not taken.
  const otherLine = `job_messages() { printf '%s\\n' 'shukka: sent release of shukkatest/api ${NEW} to i-0abc (command cmd-api)' 'shukka: sent release of shukkatest/web ${OLD} to i-0abc (command cmd-old)'; }`;
  const listed = withBin(`${otherLine}; release_command_window web ${NEW} 77 2026-11-24T00:00:00Z`, { aws: ssmStub });
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(listed.stdout.trim(), `${epoch('2026-11-24T03:00:10Z')} ${epoch('2026-11-24T03:00:20Z')}`, 'the newest matching command, not the first listed');
  const list = listed.read('aws.log').split('\n').find((l) => l.includes('list-commands')) ?? '';
  assert.ok(list.split(SEP).includes('key=InvokedAfter,value=2026-11-24T00:00:00Z'), list);
  assert.doesNotMatch(list, /max-items|page-size|starting-token/, 'the listing is read in full');
  const src = readFileSync(join(phasesDir, 'I-serialised.sh'), 'utf8');
  assert.match(src, /release_command_window web "\$a" "\$ida" "\$since"/);
  assert.match(src, /release_command_window web "\$b" "\$idb" "\$since"/);
});

test('shu-9bj.22: phase D keeps each box read as its own one-line value, and R3-box-role-refused-on-trendigle reads them', () => {
  // The box's CLI error output starts with a blank line, as it did in the rc.8 run.
  const r = runPhaseD(`if [[ "$1" == *describe-table* ]]; then printf '\\nAn error occurred (AccessDeniedException) when calling the DescribeTable operation: not authorized\\n'; else printf '\\nAn error occurred (AccessDenied) when calling the ListObjectsV2 operation:\\nAccess Denied\\n'; fi`);
  assert.equal(r.status, 0, r.stderr);
  const get = (k: string) => r.state.filter((l) => l.startsWith(`${k}=`)).at(-1)?.slice(k.length + 1);
  assert.equal(get('box_trendigle_table_read'), 'An error occurred (AccessDeniedException) when calling the DescribeTable operation: not authorized');
  assert.equal(get('box_trendigle_bucket_read'), 'An error occurred (AccessDenied) when calling the ListObjectsV2 operation: Access Denied');
  const body = `  source "${join(casesDir, 'D04-R3-box-role-refused-on-trendigle.sh')}"; case_run`;
  const st = r.state.filter((l) => l.startsWith('box_trendigle_')).map((l) => `state_set ${l.split('=')[0]} '${l.slice(l.indexOf('=') + 1)}'`).join('; ');
  const denied = runCase(body, st);
  assert.equal(denied.status, 0, denied.stderr);
  assert.match(denied.stderr, /RESULT R3-box-role-trendigle-table-read DENIED/);
  assert.match(denied.stderr, /RESULT R3-box-role-trendigle-bucket-read DENIED/);
  const allowed = runCase(body, `state_set box_trendigle_table_read ACTIVE; state_set box_trendigle_bucket_read 1`);
  assert.notEqual(allowed.status, 0);
  assert.match(allowed.stderr, /RESULT R3-box-role-trendigle-table-read ALLOWED/);
});
