// shukka init (shu-cio.1): scaffolds shukka.json, the caller workflow and prints the CDK wiring for a project, in a
// temporary repository. Nothing here calls AWS, GitHub or npm.
/* eslint-disable @typescript-eslint/no-explicit-any -- the parsed shukka.json is read loosely on purpose */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import { validateConfig } from '../scripts/config.mjs';
import { helpText, main } from '../scripts/cli/main.mjs';
import { releaseRef } from '../scripts/cli/init.mjs';

function repo(files: Record<string, string | object> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'shukka-init-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}

async function init(cwd: string, args: string[]) {
  let out = '';
  let err = '';
  const code = await main(['init', ...args], { cwd, out: (t) => { out += t; }, err: (t) => { err += t; } });
  return { code, out, err };
}

const readJson = (dir: string, path: string) => JSON.parse(readFileSync(join(dir, path), 'utf8'));

test('shu-cio.1: init writes a schema-valid shukka.json and a caller pinned to the release tag, and prints the CDK wiring', async (t) => {
  const dir = repo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = await init(dir, ['acme', '--apps', 'web,api', '--account', '123456789012', '--region', 'eu-west-1', '--ref', 'v1.2.3']);
  assert.equal(r.code, 0, r.err);

  const config = readJson(dir, 'shukka.json');
  const { problems } = validateConfig(config);
  assert.deepEqual(problems, []);
  assert.equal(config.project, 'acme');
  assert.equal(config.qualifier, 'acme');
  assert.deepEqual(config.aws, { account: '123456789012', region: 'eu-west-1' });
  assert.equal(config.$schema, 'https://raw.githubusercontent.com/rummykhan/shukka/v1.2.3/schema/shukka.schema.json');
  assert.deepEqual(config.apps.map((a: any) => a.name), ['web', 'api']);

  const workflow = readFileSync(join(dir, '.github/workflows/ci.yml'), 'utf8');
  const ci = parse(workflow);
  assert.equal(ci.jobs.shukka.uses, 'rummykhan/shukka/.github/workflows/pipeline.yml@v1.2.3');
  assert.deepEqual(ci.jobs.shukka.permissions, { contents: 'read', 'id-token': 'write', 'pull-requests': 'write' });
  assert.ok(ci.on.workflow_dispatch.inputs.allow_replacement);
  assert.ok(ci.on.workflow_dispatch.inputs.force);

  for (const name of ['shukkaSynthesizer', 'shukkaCiSynthesizer', 'ShukkaAccess', 'applyBoundary', 'tagProject']) {
    assert.match(r.out, new RegExp(`\\b${name}\\b`), `snippet names ${name}`);
  }
  assert.match(r.out, /'Acme-Ci'/);
  assert.match(r.out, /github:rummykhan\/shukka#v1\.2\.3/);
});

test('shu-cio.1: the caller pins v<package.json version> by default; --ref takes a release tag, a candidate only when asked', () => {
  assert.equal(releaseRef({ version: '1.0.3' }), 'v1.0.3');
  assert.equal(releaseRef({ version: '1.0.3', ref: 'v1.0.4' }), 'v1.0.4');
  assert.equal(releaseRef({ version: '1.0.3', ref: 'v1.1.0-rc.2' }), 'v1.1.0-rc.2');
  assert.throws(() => releaseRef({ version: '1.1.0-rc.2' }), /--ref/);
  assert.throws(() => releaseRef({ version: '0.0.0' }), /--ref/);
  for (const ref of ['v1', 'main', '1.0.3', 'v1.0', 'refs/tags/v1.0.3', 'abc1234']) {
    assert.throws(() => releaseRef({ version: '1.0.3', ref }), /release tag/, ref);
  }
});

test('shu-cio.1: init never overwrites an existing file without --force, and writes nothing when it refuses', async (t) => {
  const dir = repo({ '.github/workflows/ci.yml': 'name: old\n' });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = await init(dir, ['acme', '--apps', 'web', '--account', '123456789012', '--ref', 'v1.2.3']);
  assert.equal(r.code, 1);
  assert.match(r.err, /\.github\/workflows\/ci\.yml/);
  assert.match(r.err, /--force/);
  assert.equal(readFileSync(join(dir, '.github/workflows/ci.yml'), 'utf8'), 'name: old\n');
  assert.equal(existsSync(join(dir, 'shukka.json')), false, 'nothing written when one file refuses');

  const forced = await init(dir, ['acme', '--apps', 'web', '--account', '123456789012', '--ref', 'v1.2.3', '--force']);
  assert.equal(forced.code, 0, forced.err);
  assert.match(readFileSync(join(dir, '.github/workflows/ci.yml'), 'utf8'), /pipeline\.yml@v1\.2\.3/);
  assert.equal(readJson(dir, 'shukka.json').project, 'acme');

  const again = await init(dir, ['acme', '--apps', 'web', '--account', '123456789012', '--ref', 'v1.2.3']);
  assert.equal(again.code, 1);
  assert.match(again.err, /shukka\.json/);
});

test('shu-cio.1: init refuses a symbolic link in place of a file it writes, even with --force', async (t) => {
  const dir = repo({ 'elsewhere.json': '{}' });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  symlinkSync(join(dir, 'elsewhere.json'), join(dir, 'shukka.json'));
  const r = await init(dir, ['acme', '--apps', 'web', '--account', '123456789012', '--ref', 'v1.2.3', '--force']);
  assert.equal(r.code, 1);
  assert.match(r.err, /symbolic link/);
  assert.equal(readFileSync(join(dir, 'elsewhere.json'), 'utf8'), '{}');
});

test('shu-cio.1: init reads package.json workspaces and the cdk.json app, and leaves TODO markers for the rest', async (t) => {
  const dir = repo({
    'package.json': { name: 'acme', private: true, workspaces: ['apps/*', 'infra'] },
    'apps/web/package.json': { name: 'web', scripts: { build: 'next build', lint: 'eslint .', typecheck: 'tsc --noEmit', test: 'vitest' } },
    'apps/web/next.config.mjs': 'export default {};\n',
    'apps/worker/package.json': { name: 'worker', scripts: { test: 'node --test' } },
    'infra/package.json': { name: 'acme-infra', scripts: { test: 'node --test' } },
    'infra/tsconfig.json': '{}',
    'infra/cdk.json': { app: 'npx tsx bin/app.ts', context: {} },
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = await init(dir, ['acme', '--ref', 'v1.2.3']);
  assert.equal(r.code, 0, r.err);

  const config = readJson(dir, 'shukka.json');
  assert.deepEqual(validateConfig(config).problems, []);
  assert.deepEqual(config.infra, { dir: 'infra', paths: ['infra/**'] });
  assert.deepEqual(config.apps.map((a: any) => [a.name, a.build.dir, a.paths]), [
    ['web', 'apps/web', ['apps/web/**']],
    ['worker', 'apps/worker', ['apps/worker/**']],
  ]);
  const [web, worker] = config.apps;
  assert.deepEqual(web.build.run, ['npm ci', 'npm run build']);
  assert.equal(web.build.bundle, 'scripts/bundle.sh', 'a Next.js app uses the bundle script shukka provides');
  assert.match(worker.build.run.join(' '), /TODO/, 'no build script: a TODO command');
  assert.match(worker.build.bundle, /TODO/);
  assert.match(web.server.configure, /TODO/);
  assert.match(web.server.health, /TODO/);
  assert.match(config.smoke.run, /TODO/);
  assert.match(config.aws.account, /^0{12}$/, 'no --account: an account no one has, listed as a TODO');

  assert.deepEqual(config.checks, [
    { name: 'web', dir: 'apps/web', run: ['npm ci', 'npm run lint', 'npm run typecheck', 'npm test'] },
    { name: 'worker', dir: 'apps/worker', run: ['npm ci', 'npm test'] },
    { name: 'infra', dir: 'infra', run: ['npm ci', 'npx tsc --noEmit', 'npm test'] },
  ]);

  // The wiring goes in the app cdk.json runs, and every TODO is listed.
  assert.match(r.out, /infra\/bin\/app\.ts/);
  assert.match(r.out, /TODO.*aws\.account/);
  assert.match(r.out, /TODO.*apps\[1\]\.build\.run/);
  assert.match(r.out, /TODO.*githubRepo|githubRepo.*TODO/);
});

test('shu-cio.1: without a cdk.json or workspaces, init says so in TODOs; a cdk.json app without tsx gets a TODO', async (t) => {
  const bare = repo();
  t.after(() => rmSync(bare, { recursive: true, force: true }));
  const r = await init(bare, ['acme', '--account', '123456789012', '--ref', 'v1.2.3']);
  assert.equal(r.code, 0, r.err);
  const config = readJson(bare, 'shukka.json');
  assert.deepEqual(validateConfig(config).problems, []);
  assert.deepEqual(config.apps, []);
  assert.match(r.out, /TODO.*cdk\.json/);
  assert.match(r.out, /TODO.*--apps/);

  const node = repo({ 'cdk.json': { app: 'npx ts-node --prefer-ts-exts bin/app.ts' } });
  t.after(() => rmSync(node, { recursive: true, force: true }));
  const n = await init(node, ['acme', '--apps', 'web', '--account', '123456789012', '--ref', 'v1.2.3']);
  assert.equal(n.code, 0, n.err);
  assert.equal(readJson(node, 'shukka.json').infra.dir, '.');
  assert.match(n.out, /TODO.*tsx/);
});

test('shu-cio.1: init refuses a bad project or app name as a usage error, and init is in --help', async (t) => {
  const dir = repo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal((await init(dir, ['Acme', '--ref', 'v1.2.3'])).code, 2);
  assert.equal((await init(dir, ['--ref', 'v1.2.3'])).code, 2);
  assert.equal((await init(dir, ['acme', '--apps', 'Web', '--ref', 'v1.2.3'])).code, 2);
  assert.equal((await init(dir, ['acme', '--account', '12', '--ref', 'v1.2.3'])).code, 2);
  assert.equal(existsSync(join(dir, 'shukka.json')), false);
  assert.match(helpText(), /^ {2}init <project>/m);

  // A long or hyphenated name gets a qualifier CDK accepts.
  const long = await init(dir, ['acme-shop-eu', '--apps', 'web', '--account', '123456789012', '--ref', 'v1.2.3']);
  assert.equal(long.code, 0, long.err);
  const config = readJson(dir, 'shukka.json');
  assert.equal(config.qualifier, 'acmeshopeu');
  assert.deepEqual(validateConfig(config).problems, []);
});
