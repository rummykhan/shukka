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
