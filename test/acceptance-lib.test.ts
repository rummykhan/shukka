import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    const fakes = `clean_consumer_github() { :; }; require_consumer_remote() { :; }; commit_all() { printf '%s\\n' ${SHA}; }; c_git() { printf 'gh-stub-git %s\\n' "$*" >>"$STUB_DIR/gh.log"; }`;
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
