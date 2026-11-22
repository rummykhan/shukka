import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { main, upload } from '../scripts/upload.mjs';
import { bundleDir, dotenv, HOOK, SHA, stubClient, tarEntries, withTmp, write } from './helpers/release-fixtures.js';

test('shu-mf3: upload puts the bundle at <project>/<app>/<sha>.tgz in the bucket', withTmp(async (root) => {
  const { calls, client } = stubClient();
  const result = await upload({ dir: bundleDir(root), bucket: 'shukkatest-deploy-123', project: 'shukkatest', app: 'web', sha: SHA, s3: client });
  assert.equal(calls.length, 1);
  const command = calls[0]!;
  assert.ok(command instanceof PutObjectCommand);
  assert.equal(command.input.Bucket, 'shukkatest-deploy-123');
  assert.equal(command.input.Key, `shukkatest/web/${SHA}.tgz`);
  assert.equal(result.url, `s3://shukkatest-deploy-123/shukkatest/web/${SHA}.tgz`);
  const entries = tarEntries(gunzipSync(command.input.Body as Buffer));
  const names = entries.map((e) => e.name);
  for (const expected of ['server.js', '.next/static/chunk.js', 'public/robots.txt']) {
    assert.ok(names.includes(expected), `${expected} in ${names.join(', ')}`);
  }
  assert.equal(entries.find((e) => e.name === 'server.js')!.body.toString(), 'console.log("hi")\n');
}));

test('shu-mf3: the tarball carries no macOS extended attributes or AppleDouble files', withTmp(async (root) => {
  const dir = bundleDir(root);
  if (spawnSync('xattr', ['-h']).status === 0) {
    execFileSync('xattr', ['-w', 'com.apple.quarantine', '0081;00000000;Safari;', join(dir, 'server.js')]);
    execFileSync('xattr', ['-w', 'com.example.shukka', 'planted', join(dir, 'public', 'robots.txt')]);
    assert.match(execFileSync('xattr', [join(dir, 'server.js')], { encoding: 'utf8' }), /com\.apple\.quarantine/);
  }
  const { calls, client } = stubClient();
  await upload({ dir, bucket: 'b-bucket', project: 'shukkatest', app: 'web', sha: SHA, s3: client });
  const tar = gunzipSync(calls[0]!.input.Body as Buffer);
  const entries = tarEntries(tar);
  assert.ok(entries.length > 0);
  for (const e of entries) {
    assert.ok(!/(^|\/)\._/.test(e.name), `AppleDouble entry ${e.name}`);
    assert.ok(e.type !== 'x' || !/xattr|com\.apple|com\.example/i.test(e.body.toString('utf8')), `extended attributes in pax header for ${e.name}`);
  }
  assert.ok(!tar.includes('com.apple.quarantine'), 'quarantine attribute in the tarball');
  assert.ok(!tar.includes('com.example.shukka'), 'planted attribute in the tarball');
  assert.ok(!tar.includes('LIBARCHIVE.xattr') && !tar.includes('SCHILY.xattr'), 'xattr records in the tarball');
}));

test('shu-mf3: a bundle holding any .env* file is refused and nothing is uploaded', withTmp(async (root) => {
  const dir = bundleDir(root);
  write(join(dir, dotenv('.production')), 'SECRET=fixture-secret-value\n');
  write(join(dir, 'apps', 'web', dotenv()), 'OTHER=1\n');
  const { calls, client } = stubClient();
  await assert.rejects(
    upload({ dir, bucket: 'b-bucket', project: 'shukkatest', app: 'web', sha: SHA, s3: client }),
    (error: Error) => {
      assert.ok(error.message.includes(`refused: ${dotenv('.production')} `), error.message);
      assert.ok(error.message.includes(`refused: apps/web/${dotenv()} `), error.message);
      assert.ok(!error.message.includes('fixture-secret-value'));
      return true;
    },
  );
  assert.equal(calls.length, 0);
}));

test('shu-mf3: bad names are refused before anything is packed', withTmp(async (root) => {
  const { calls, client } = stubClient();
  await assert.rejects(
    upload({ dir: bundleDir(root), bucket: 'b-bucket', project: 'shukkatest', app: '../x', sha: 'HEAD', s3: client }),
    (error: Error) => /app:/.test(error.message) && /sha:/.test(error.message),
  );
  assert.equal(calls.length, 0);
}));

test('shu-mf3: upload CLI reads the project from shukka.json and prints the s3 URL', withTmp(async (root) => {
  const config = join(root, 'shukka.json');
  writeFileSync(config, JSON.stringify({
    project: 'shukkatest', qualifier: 'shukkatest', aws: { account: '123456789012', region: 'us-east-1' },
    checks: [], infra: { dir: 'infra', paths: ['infra/**'] },
    apps: [{ name: 'web', paths: ['web/**'], build: { dir: 'web', run: ['npm run build'], bundle: 'scripts/bundle.sh' },
      server: { configure: HOOK, units: ['web'], health: 'http://127.0.0.1:3000/' } }],
  }));
  const { calls, client } = stubClient();
  const dir = bundleDir(root);
  let stdout = '';
  const out = (t: string) => { stdout += t; };
  const code = await main(['--config', config, '--app', 'web', '--dir', dir, '--bucket', 'b-bucket', '--sha', SHA], { s3: client, out });
  assert.equal(code, 0);
  assert.equal(calls[0]!.input.Key, `shukkatest/web/${SHA}.tgz`);
  assert.equal(stdout.trim().split('\n').pop(), `s3://b-bucket/shukkatest/web/${SHA}.tgz`);
}));

test('shu-mf3: symbolic links that are absolute or lead outside the bundle are refused; links inside are kept', withTmp(async (root) => {
  const outside = join(root, 'outside.txt');
  write(outside, 'outside');
  const cases: Array<[string, string]> = [
    ['abs', '/etc/passwd'],
    ['up', '../outside.txt'],
    ['public/up2', '../../outside.txt'],
    ['roundtrip', '../bundle/server.js'], // inside on this machine, outside once the release dir is named differently
    ['dangling', 'missing.txt'],
  ];
  for (const [name, target] of cases) {
    const dir = bundleDir(join(root, name.replace('/', '-')));
    symlinkSync(target, join(dir, name));
    const { calls, client } = stubClient();
    await assert.rejects(upload({ dir, bucket: 'b-bucket', project: 'shukkatest', app: 'web', sha: SHA, s3: client }),
      (error: Error) => error.message.includes(`refused: ${name} is a symbolic link`), `${name} -> ${target}`);
    assert.equal(calls.length, 0);
  }
  // A link through an internal link that points at the root, then up: escapes once followed.
  const sneaky = bundleDir(join(root, 'sneaky'));
  symlinkSync('.', join(sneaky, 'self'));
  symlinkSync('self/../outside.txt', join(sneaky, 'esc'));
  await assert.rejects(upload({ dir: sneaky, bucket: 'b-bucket', project: 'shukkatest', app: 'web', sha: SHA, s3: stubClient().client }),
    /refused: esc is a symbolic link that leads outside/);

  const dir = bundleDir(join(root, 'ok'));
  mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
  symlinkSync('../../server.js', join(dir, 'node_modules', '.bin', 'server'));
  const { calls, client } = stubClient();
  await upload({ dir, bucket: 'b-bucket', project: 'shukkatest', app: 'web', sha: SHA, s3: client });
  const link = tarEntries(gunzipSync(calls[0]!.input.Body as Buffer)).find((e) => e.name === 'node_modules/.bin/server');
  assert.equal(link?.type, '2');
}));

test('shu-mf3: special files and setuid or setgid files are refused', withTmp(async (root) => {
  const fifoDir = bundleDir(join(root, 'fifo'));
  execFileSync('mkfifo', [join(fifoDir, 'pipe')]);
  await assert.rejects(upload({ dir: fifoDir, bucket: 'b-bucket', project: 'shukkatest', app: 'web', sha: SHA, s3: stubClient().client }),
    /refused: pipe is not a regular file, directory or symbolic link/);
  for (const mode of [0o4755, 0o2755]) {
    const dir = bundleDir(join(root, `mode-${mode.toString(8)}`));
    write(join(dir, 'tool'), '#!/bin/sh\n');
    chmodSync(join(dir, 'tool'), mode);
    const { calls, client } = stubClient();
    await assert.rejects(upload({ dir, bucket: 'b-bucket', project: 'shukkatest', app: 'web', sha: SHA, s3: client }),
      /refused: tool is setuid or setgid/);
    assert.equal(calls.length, 0);
  }
}));

test('shu-mf3: every tarball entry is owned by 0:0 and carries no setuid or setgid bit', withTmp(async (root) => {
  const dir = bundleDir(root);
  chmodSync(join(dir, 'server.js'), 0o755);
  const { calls, client } = stubClient();
  await upload({ dir, bucket: 'b-bucket', project: 'shukkatest', app: 'web', sha: SHA, s3: client });
  const entries = tarEntries(gunzipSync(calls[0]!.input.Body as Buffer)).filter((e) => e.type !== 'x' && e.type !== 'g');
  assert.ok(entries.length >= 4);
  for (const e of entries) {
    assert.equal(e.uid, 0, `${e.name} uid`);
    assert.equal(e.gid, 0, `${e.name} gid`);
    assert.equal(e.mode & 0o6000, 0, `${e.name} mode`);
  }
  assert.equal(entries.find((e) => e.name === 'server.js')!.mode & 0o777, 0o755);
}));
