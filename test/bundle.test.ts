import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { upload } from '../scripts/upload.mjs';
import { dotenv, SHA, stubClient, withTmp, write } from './helpers/release-fixtures.js';

const bundleScript = fileURLToPath(new URL('../scripts/bundle.sh', import.meta.url));

/** A Next.js build tree laid out as `next build` with output: 'standalone' leaves it (as Trendigle's). */
function nextBuild(root: string): string {
  const app = join(root, 'app');
  write(join(app, 'package.json'), '{"name":"app"}\n');
  write(join(app, dotenv()), 'LOCAL=1\n');
  write(join(app, 'public', 'favicon.ico'), 'icon');
  write(join(app, '.next', 'static', 'chunks', 'main.js'), 'main chunk');
  write(join(app, '.next', 'server', 'app', 'page.js'), 'server page (not part of standalone)');
  const sa = join(app, '.next', 'standalone');
  write(join(sa, 'server.js'), 'require("next")\n');
  write(join(sa, 'package.json'), '{"name":"app"}\n');
  write(join(sa, dotenv()), 'SECRET=fixture-secret\n');
  write(join(sa, dotenv('.production')), 'SECRET=fixture-secret\n');
  write(join(sa, 'node_modules', 'next', 'index.js'), 'module.exports = {}\n');
  write(join(sa, '.next', 'server', 'app', 'page.js'), 'server page');
  write(join(sa, '.next', 'BUILD_ID'), 'build-1');
  return app;
}

function bundle(cwd: string, args: string[] = []) {
  return spawnSync('bash', [bundleScript, ...args], { cwd, encoding: 'utf8' });
}

test('shu-mf3: bundle.sh turns a Next.js standalone build into a deployable directory and prints its path', withTmp(async (root) => {
  const app = nextBuild(root);
  const run = bundle(app);
  assert.equal(run.status, 0, run.stderr);
  const lines = run.stdout.trim().split('\n');
  assert.equal(lines.length, 1, 'only the path on stdout');
  const out = lines[0]!;
  assert.equal(out, join(realpathSync(app), '.next', 'shukka-bundle'));
  assert.equal(readFileSync(join(out, 'server.js'), 'utf8'), 'require("next")\n');
  assert.ok(existsSync(join(out, 'node_modules', 'next', 'index.js')));
  assert.ok(existsSync(join(out, '.next', 'BUILD_ID')));
  assert.equal(readFileSync(join(out, '.next', 'static', 'chunks', 'main.js'), 'utf8'), 'main chunk');
  assert.equal(readFileSync(join(out, 'public', 'favicon.ico'), 'utf8'), 'icon');
  assert.ok(!existsSync(join(out, dotenv())));
  assert.ok(!existsSync(join(out, dotenv('.production'))));
  assert.ok(!run.stdout.includes('fixture-secret') && !run.stderr.includes('fixture-secret'));

  // Running it again starts from a clean copy, and the result is accepted by upload.
  write(join(out, 'stale.txt'), 'old');
  const again = bundle(root, [app]);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.stdout.trim(), out);
  assert.ok(!existsSync(join(out, 'stale.txt')));
  const { calls, client } = stubClient();
  await upload({ dir: out, bucket: 'b-bucket', project: 'shukkatest', app: 'web', sha: SHA, s3: client });
  assert.equal(calls.length, 1);
}));

test('shu-mf3: bundle.sh works without a public directory and refuses a build that is not standalone', withTmp((root) => {
  const app = nextBuild(root);
  spawnSync('rm', ['-rf', join(app, 'public')]);
  const run = bundle(app);
  assert.equal(run.status, 0, run.stderr);
  assert.ok(!existsSync(join(run.stdout.trim(), 'public')));

  spawnSync('rm', ['-rf', join(app, '.next', 'standalone')]);
  const refused = bundle(app);
  assert.equal(refused.status, 1);
  assert.equal(refused.stdout, '');
  assert.match(refused.stderr, /output: 'standalone'/);
}));
