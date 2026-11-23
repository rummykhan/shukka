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

function withStubs(script: string): { status: number | null; stderr: string; calls: string[][] } {
  const dir = mkdtempSync(join(tmpdir(), 'shu-9bj13-'));
  try {
    const bin = join(dir, 'bin');
    spawnSync('mkdir', ['-p', bin, join(dir, 'run', 'runs')]);
    writeFileSync(join(bin, 'aws'), awsStub);
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
    return { status: r.status, stderr: r.stderr, calls };
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
