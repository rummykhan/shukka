import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkProjectName, derivedNames, loadConfig, validateConfig } from '../scripts/config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const script = join(root, 'scripts', 'config.mjs');
const examplePath = join(here, 'fixtures', 'config', 'trendigle.json');

// Tests mutate the parsed JSON at arbitrary depth, so it is deliberately loosely typed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;

/** A fresh copy of the design's Trendigle example, safe to mutate. */
function example(): Loose {
  return JSON.parse(readFileSync(examplePath, 'utf8'));
}

/** Validate and return the problems, asserting that at least one mentions `fragment`. */
function problemsFor(config: unknown, fragment: RegExp): string[] {
  const { problems } = validateConfig(config);
  assert.ok(problems.length > 0, 'expected the config to be refused');
  assert.ok(
    problems.some((p) => fragment.test(p)),
    `expected a problem matching ${fragment}, got:\n${problems.join('\n')}`,
  );
  for (const p of problems) assert.ok(!p.includes('\n'), `a problem spans lines: ${p}`);
  return problems;
}

test('shu-9wa: the design example in docs matches the fixture', () => {
  const design = readFileSync(join(root, 'docs', 'factory', 'v1', 'design.md'), 'utf8');
  const block = design.split('### `shukka.json`')[1]?.split('```json')[1]?.split('```')[0];
  assert.ok(block, 'design has a shukka.json example');
  assert.deepEqual(JSON.parse(block), example());
});

test("shu-9wa: the design's Trendigle example validates against the schema", () => {
  const { problems } = validateConfig(example());
  assert.deepEqual(problems, []);
});

test('shu-9wa: the schema names exactly the contract keys', () => {
  const schema = JSON.parse(readFileSync(join(root, 'schema', 'shukka.schema.json'), 'utf8'));
  assert.deepEqual(Object.keys(schema.properties).sort(), [
    '$schema', 'alwaysDeploy', 'apps', 'aws', 'checks', 'infra', 'node', 'project', 'qualifier', 'smoke',
  ]);
  assert.equal(schema.additionalProperties, false);
  const app = schema.definitions.app;
  assert.deepEqual(Object.keys(app.properties).sort(), ['build', 'name', 'paths', 'server']);
  assert.deepEqual(Object.keys(app.properties.build.properties).sort(), ['buildEnv', 'bundle', 'dir', 'env', 'run']);
  assert.deepEqual(Object.keys(app.properties.server.properties).sort(), ['configure', 'health', 'units']);
});

test('shu-9wa: project format is enforced', () => {
  for (const bad of ['Trendigle', '1trendigle', 'a', 'trend_igle', 'x'.repeat(22)]) {
    const c = example();
    c.project = bad;
    problemsFor(c, /^project: /);
  }
  const c = example();
  c.project = 'my-app-2';
  assert.deepEqual(validateConfig(c).problems, []);
});

test('shu-9wa: qualifier format is enforced', () => {
  for (const bad of ['Trend', '1trend', 'tr-end', 'a']) {
    const c = example();
    c.qualifier = bad;
    problemsFor(c, /^qualifier: /);
  }
});

test('shu-9wa: qualifier is at most 10 lowercase alphanumerics', () => {
  const c = example();
  c.qualifier = 'abcdefghijk';
  problemsFor(c, /^qualifier: .*\^\[a-z0-9\]\{1,10\}\$/);
  c.qualifier = 'abcdefghij';
  assert.deepEqual(validateConfig(c).problems, []);
});

test('shu-9wa: unknown keys are refused at every level', () => {
  const c = example();
  c.roles = { infra: 'arn:aws:iam::1:role/x' };
  c.aws.profile = 'stelking';
  c.apps[0].server.port = 3200;
  const problems = problemsFor(c, /^roles: unknown key$/);
  assert.ok(problems.includes('aws.profile: unknown key'), problems.join('\n'));
  assert.ok(problems.includes('apps[0].server.port: unknown key'), problems.join('\n'));
});

test('shu-9wa: missing commands are refused', () => {
  const cases: Array<[(c: Loose) => void, RegExp]> = [
    [(c) => { delete c.apps[0].build.run; }, /^apps\[0\]\.build: missing required key "run"$/],
    [(c) => { c.apps[1].build.run = []; }, /^apps\[1\]\.build\.run: /],
    [(c) => { c.checks[0].run = ['npm ci', '  ']; }, /^checks\[0\]\.run\[1\]: /],
    [(c) => { delete c.checks[1].run; }, /^checks\[1\]: missing required key "run"$/],
    [(c) => { delete c.apps[0].build.bundle; }, /^apps\[0\]\.build: missing required key "bundle"$/],
    [(c) => { delete c.apps[0].server.configure; }, /^apps\[0\]\.server: missing required key "configure"$/],
    [(c) => { c.smoke = {}; }, /^smoke: missing required key "run"$/],
    [(c) => { c.smoke.run = ''; }, /^smoke\.run: /],
  ];
  for (const [mutate, fragment] of cases) {
    const c = example();
    mutate(c);
    problemsFor(c, fragment);
  }
});

test('shu-9wa: health must be an http URL', () => {
  for (const bad of ['127.0.0.1:3200/login', 'ftp://127.0.0.1/login', 'http://', 'http:// x', 'file:///etc/passwd']) {
    const c = example();
    c.apps[0].server.health = bad;
    problemsFor(c, /^apps\[0\]\.server\.health: /);
  }
  const c = example();
  c.apps[0].server.health = 'https://example.com';
  assert.deepEqual(validateConfig(c).problems, []);
});

test('shu-9wa: app names must be unique', () => {
  const c = example();
  c.apps[1].name = 'app';
  problemsFor(c, /^apps\[1\]\.name: duplicate app name "app"/);
});

test('shu-9wa: every problem is reported, one line each', () => {
  const c = example();
  c.project = 'Bad';
  c.qualifier = 'waytoolongqualifier';
  c.extra = true;
  c.apps[0].server.health = 'nope';
  const { problems } = validateConfig(c);
  assert.ok(problems.length >= 4, problems.join('\n'));
});

test('shu-9wa: a project name that prefixes or is prefixed by a known name is refused', () => {
  assert.deepEqual(checkProjectName('trendigle', ['orbitary']), []);
  assert.deepEqual(checkProjectName('trendigle', ['trendigle']), [], 'its own name is not a conflict');
  assert.match(checkProjectName('trend', ['orbitary', 'trendigle'])[0] ?? '', /^project: "trend" is a prefix of known project "trendigle"$/);
  assert.match(checkProjectName('trendigle2', ['trendigle'])[0] ?? '', /^project: known project "trendigle" is a prefix of "trendigle2"$/);
  const c = example();
  c.project = 'trend';
  assert.deepEqual(validateConfig(c, { knownProjects: ['trendigle'] }).problems, [
    'project: "trend" is a prefix of known project "trendigle"',
  ]);
  assert.deepEqual(validateConfig(c).problems, [], 'no list, no prefix check');
});

test('shu-9wa: role and stack names are derived for the example', () => {
  assert.deepEqual(derivedNames('trendigle'), {
    infra: 'trendigle-shukka-infra',
    app: 'trendigle-shukka-app',
    diff: 'trendigle-shukka-diff',
  });
  const { config } = validateConfig(example());
  assert.deepEqual(config?.derived, {
    infra: 'trendigle-shukka-infra',
    app: 'trendigle-shukka-app',
    diff: 'trendigle-shukka-diff',
  });
  const c = example();
  c.derived = { infra: 'x' };
  problemsFor(c, /^derived: unknown key$/);
});

test('shu-9wa: loadConfig reads a file and reports unreadable or invalid JSON as one problem', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shu-9wa-'));
  try {
    assert.deepEqual(loadConfig(examplePath).problems, []);
    assert.match(loadConfig(join(dir, 'missing.json')).problems[0] ?? '', /^cannot read /);
    writeFileSync(join(dir, 'bad.json'), '{ "project": ');
    const bad = loadConfig(join(dir, 'bad.json'));
    assert.equal(bad.problems.length, 1);
    assert.match(bad.problems[0] ?? '', /^not valid JSON: /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shu-9wa: CLI --json prints the normalised config', () => {
  const out = execFileSync(process.execPath, [script, examplePath, '--json'], { encoding: 'utf8' });
  const config = JSON.parse(out);
  assert.equal(config.$schema, undefined);
  assert.equal(config.project, 'trendigle');
  assert.equal(config.node, '22');
  assert.equal(config.alwaysDeploy, false);
  assert.deepEqual(config.apps[1].build.env, {});
  assert.deepEqual(config.apps[1].build.buildEnv, []);
  assert.deepEqual(config.apps[0].build.buildEnv, ['LEGAL_ENTITY', 'CONTACT_EMAIL']);
  assert.equal(config.derived.diff, 'trendigle-shukka-diff');
});

test('shu-9wa: CLI fills defaults for a minimal config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shu-9wa-'));
  try {
    const c = example();
    delete c.node; delete c.checks; delete c.smoke; delete c.alwaysDeploy;
    writeFileSync(join(dir, 'shukka.json'), JSON.stringify(c));
    const config = JSON.parse(execFileSync(process.execPath, [script, join(dir, 'shukka.json'), '--json'], { encoding: 'utf8' }));
    assert.equal(config.node, '22');
    assert.deepEqual(config.checks, []);
    assert.equal(config.smoke, null);
    assert.equal(config.alwaysDeploy, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shu-9wa: CLI exits non-zero with one line per problem', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shu-9wa-'));
  try {
    const c = example();
    c.project = 'Bad';
    c.apps[1].name = 'app';
    c.unknown = 1;
    writeFileSync(join(dir, 'shukka.json'), JSON.stringify(c));
    const run = spawnSync(process.execPath, [script, join(dir, 'shukka.json'), '--json'], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.equal(run.stdout, '');
    const lines = run.stderr.trim().split('\n');
    assert.equal(lines.length, 3, run.stderr);
    assert.ok(lines.some((l) => l.startsWith('project: ')));
    assert.ok(lines.some((l) => l.startsWith('apps[1].name: ')));
    assert.ok(lines.includes('unknown: unknown key'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shu-9wa: CLI --known refuses a prefix clash', () => {
  const run = spawnSync(process.execPath, [script, examplePath, '--known', 'orbitary,trendigleadmin'], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.equal(run.stderr.trim(), 'project: "trendigle" is a prefix of known project "trendigleadmin"');
  const ok = spawnSync(process.execPath, [script, examplePath, '--known', 'orbitary'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
});

test('shu-9wa: CLI without a path prints usage and exits 2', () => {
  const run = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /usage: node scripts\/config\.mjs <path>/);
});
