import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
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
