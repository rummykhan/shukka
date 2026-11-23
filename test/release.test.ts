import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { GetCommandInvocationCommand, SendCommandCommand } from '@aws-sdk/client-ssm';
import { buildCommands, checkArgs, EXIT_MESSAGES, hookKey, main, readHook, release, resultLine, scriptArgs, waitOnline } from '../scripts/release.mjs';
import { upload } from '../scripts/upload.mjs';
import { bundleDir, GOOD_HOOK, gitCheckout, headOf, HOOK, SHA, stubClient, tarEntries, withTmp, write } from './helpers/release-fixtures.js';

const BUNDLE_SHA256 = 'b'.repeat(64);
const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const SCRIPT = '#!/usr/bin/env bash\n# stand-in for box/shukka-release.sh\nprintf "%s\\n" "$@"\n';

type Invocation = { Status: string; ResponseCode?: number; StandardOutputContent?: string; StandardErrorContent?: string };

/** EC2 stand-in: instances tagged Project=<project>, over two pages. */
function stubEc2(ids: string[] = ['i-0aaa', 'i-0bbb']) {
  return stubClient((command) => {
    if (!(command instanceof DescribeInstancesCommand)) throw new Error(`unexpected ${command.constructor.name}`);
    if (ids.length === 0) return { Reservations: [] };
    if (!command.input.NextToken) return { Reservations: [{ Instances: [{ InstanceId: ids[0] }] }], NextToken: ids.length > 1 ? 'page2' : undefined };
    return { Reservations: [{ Instances: ids.slice(1).map((InstanceId) => ({ InstanceId })) }] };
  });
}

/** SSM stand-in: the invocation is missing at first, then in progress, then `final`. */
function stubSsm(final: (instanceId: string) => Invocation) {
  const polls = new Map<string, number>();
  return stubClient((command) => {
    if (command instanceof SendCommandCommand) return { Command: { CommandId: 'cmd-123' } };
    if (command instanceof GetCommandInvocationCommand) {
      const id = String(command.input.InstanceId);
      const n = (polls.get(id) ?? 0) + 1;
      polls.set(id, n);
      if (n === 1) throw Object.assign(new Error('not yet'), { name: 'InvocationDoesNotExist' });
      if (n === 2) return { Status: 'InProgress', ResponseCode: -1 };
      return final(id);
    }
    throw new Error(`unexpected ${command.constructor.name}`);
  });
}

function baseOptions(root: string, scriptPath: string) {
  return {
    project: 'shukkatest', app: 'web', sha: SHA, bucket: 'shukkatest-deploy-123', region: 'us-east-1',
    units: ['shukkatest-web', 'shukkatest-tick'], health: 'http://127.0.0.1:3000/login',
    checkout: gitCheckout(root), configure: HOOK, script: scriptPath, pollMs: 0, bundleSha256: BUNDLE_SHA256,
  };
}

function scriptFile(root: string): string {
  const path = join(root, 'shukka-release.sh');
  writeFileSync(path, SCRIPT);
  return path;
}

test('shu-mf3: release sends shukka-release.sh with its arguments through SSM to instances tagged Project, waits and prints the output', withTmp(async (root) => {
  const ec2 = stubEc2();
  const ssm = stubSsm((id) => ({ Status: 'Success', ResponseCode: 0, StandardOutputContent: `released on ${id}\nshukka: shukkatest/web none -> ${SHA} live\n` }));
  const s3 = stubClient();
  let printed = '';
  const result = await release({ ...baseOptions(root, scriptFile(root)), ec2: ec2.client, ssm: ssm.client, s3: s3.client, out: (t) => { printed += t; } });

  assert.equal(result.ok, true);
  assert.equal(result.code, 0);
  const filters = ec2.calls[0]!.input.Filters as Array<{ Name: string; Values: string[] }>;
  assert.deepEqual(filters.find((f) => f.Name === 'tag:Project')?.Values, ['shukkatest']);
  assert.deepEqual(filters.find((f) => f.Name === 'instance-state-name')?.Values, ['running']);

  const sent = ssm.calls.find((c) => c instanceof SendCommandCommand)!;
  assert.equal(sent.input.DocumentName, 'AWS-RunShellScript');
  assert.deepEqual(sent.input.InstanceIds, ['i-0aaa', 'i-0bbb']);
  const commands = (sent.input.Parameters as { commands: string[] }).commands;
  // Run the very command lines SSM would run, with the stand-in script: it echoes its arguments.
  const run = spawnSync('sh', ['-c', commands.join('\n')], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.stdout.trim().split('\n'), [
    '--project', 'shukkatest', '--app', 'web', '--sha', SHA, '--bucket', 'shukkatest-deploy-123', '--region', 'us-east-1',
    '--configure-key', `shukkatest/web/${SHA}.configure.sh`,
    '--configure-sha256', sha256(GOOD_HOOK), '--bundle-sha256', BUNDLE_SHA256,
    '--units', 'shukkatest-web shukkatest-tick', '--health', 'http://127.0.0.1:3000/login',
  ]);
  assert.match(printed, /released on i-0aaa/);
  assert.match(printed, /released on i-0bbb/);
  assert.match(printed, new RegExp(`shukka: shukkatest/web none -> ${SHA} live`));
}));

test('shu-mf3: release maps each exit code of the release script to its failure message', withTmp(async (root) => {
  const script = scriptFile(root);
  const options = baseOptions(root, script);
  const results = { 10: 'download-failed', 11: 'configure-failed', 12: 'rolled-back', 13: 'rollback-unhealthy' } as const;
  for (const [codeText, word] of Object.entries(results)) {
    const code = Number(codeText) as 10 | 11 | 12 | 13;
    const last = `shukka: shukkatest/web 1111111 -> ${SHA} ${word}`;
    const ssm = stubSsm(() => ({ Status: 'Failed', ResponseCode: code, StandardOutputContent: `working\n${last}\n` }));
    let printed = '';
    const result = await release({ ...options, ec2: stubEc2(['i-0aaa']).client, ssm: ssm.client, s3: stubClient().client, out: (t) => { printed += t; } });
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
    assert.equal(result.results[0]!.message, EXIT_MESSAGES[code]);
    assert.ok(printed.includes(`shukka: release failed on i-0aaa: ${EXIT_MESSAGES[code]} (${last})`), printed);
  }
  // Distinct messages for distinct codes.
  assert.equal(new Set(Object.values(EXIT_MESSAGES)).size, 4);
}));

test('shu-mf3: release fails on an unknown exit code, a timeout, or no tagged instance', withTmp(async (root) => {
  const options = baseOptions(root, scriptFile(root));
  const other = await release({ ...options, ec2: stubEc2(['i-0aaa']).client, s3: stubClient().client, out: () => {},
    ssm: stubSsm(() => ({ Status: 'Failed', ResponseCode: 7 })).client });
  assert.equal(other.code, 1);
  assert.match(other.results[0]!.message ?? '', /exited with code 7/);

  const timedOut = await release({ ...options, ec2: stubEc2(['i-0aaa']).client, s3: stubClient().client, out: () => {},
    ssm: stubSsm(() => ({ Status: 'TimedOut', ResponseCode: -1 })).client });
  assert.equal(timedOut.code, 1);
  assert.match(timedOut.results[0]!.message ?? '', /did not finish/);

  const ssm = stubSsm(() => ({ Status: 'Success', ResponseCode: 0 }));
  await assert.rejects(
    release({ ...options, ec2: stubEc2([]).client, ssm: ssm.client, s3: stubClient().client, out: () => {} }),
    /no running instance is tagged Project=shukkatest/,
  );
  assert.equal(ssm.calls.length, 0);
}));

test('shu-mf3: the configure hook is read from the git checkout, uploaded beside the bundle and passed as --configure-key; a hook in the bundle changes nothing', withTmp(async (root) => {
  // The bundle carries a different hook at the configured path.
  const dir = bundleDir(root);
  write(join(dir, HOOK), '#!/bin/sh\necho planted by the build\n');
  const s3 = stubClient();
  await upload({ dir, bucket: 'shukkatest-deploy-123', project: 'shukkatest', app: 'web', sha: SHA, s3: s3.client });
  const bundled = tarEntries(gunzipSync(s3.calls[0]!.input.Body as Buffer)).find((e) => e.name === HOOK);
  assert.match(bundled!.body.toString(), /planted/); // the bundle is shipped as built...

  const options = baseOptions(root, scriptFile(root));
  // ...and the working tree is changed after checkout (an artifact unpacked over it): not git either.
  writeFileSync(join(options.checkout, HOOK), '#!/bin/sh\necho written after checkout\n');
  const ssm = stubSsm(() => ({ Status: 'Success', ResponseCode: 0 }));
  await release({ ...options, ec2: stubEc2(['i-0aaa']).client, ssm: ssm.client, s3: s3.client, out: () => {} });

  const hookPut = s3.calls[1]!;
  assert.ok(hookPut instanceof PutObjectCommand);
  assert.equal(hookPut.input.Bucket, 'shukkatest-deploy-123');
  assert.equal(hookPut.input.Key, `shukkatest/web/${SHA}.configure.sh`);
  assert.equal(hookKey('shukkatest', 'web', SHA), hookPut.input.Key);
  assert.equal(Buffer.from(hookPut.input.Body as Buffer).toString(), GOOD_HOOK);
  const commands = (ssm.calls.find((c) => c instanceof SendCommandCommand)!.input.Parameters as { commands: string[] }).commands;
  assert.ok(commands.join('\n').includes(`'--configure-key' 'shukkatest/web/${SHA}.configure.sh'`));
  assert.ok(!scriptArgs(options, sha256(GOOD_HOOK)).includes('--configure'));
}));

test('shu-mf3: a hook that is not a committed regular file at the checkout root is refused', withTmp(async (root) => {
  const checkout = gitCheckout(root, { 'README.md': 'x\n', 'implementation/keep.txt': 'x\n' });
  const head = headOf(checkout);
  assert.throws(() => readHook(checkout, HOOK, head), /not committed/);
  write(join(checkout, HOOK), GOOD_HOOK); // on disk but not committed
  assert.throws(() => readHook(checkout, HOOK, head), /not committed/);
  assert.throws(() => readHook(checkout, '../outside.sh', head), /relative path inside the repository/);
  assert.throws(() => readHook(checkout, '/etc/passwd', head), /relative path inside the repository/);
  spawnSync('ln', ['-s', '/etc/hosts', join(checkout, 'link.sh')]);
  spawnSync('git', ['-C', checkout, 'add', 'link.sh']);
  spawnSync('git', ['-C', checkout, 'commit', '-q', '-m', 'link']);
  assert.throws(() => readHook(checkout, 'link.sh', headOf(checkout)), /not a regular file/);
  assert.throws(() => readHook(join(checkout, 'implementation'), 'x.sh', headOf(checkout)), /not the root/);
}));

test('shu-mf3: shell quoting keeps odd argument values intact', () => {
  const commands = buildCommands(SCRIPT, ['--health', "http://h/it's here; rm -rf /", '--units', 'a b']);
  const run = spawnSync('sh', ['-c', commands.join('\n')], { encoding: 'utf8' });
  assert.deepEqual(run.stdout.trim().split('\n'), ['--health', "http://h/it's here; rm -rf /", '--units', 'a b']);
});

test('shu-mf3: release CLI takes project, hook path, units and health from shukka.json and exits with the script code', withTmp(async (root) => {
  const config = join(root, 'shukka.json');
  writeFileSync(config, JSON.stringify({
    project: 'shukkatest', qualifier: 'shukkatest', aws: { account: '123456789012', region: 'us-east-1' },
    checks: [], infra: { dir: 'infra', paths: ['infra/**'] },
    apps: [{ name: 'web', paths: ['web/**'], build: { dir: 'web', run: ['npm run build'], bundle: 'scripts/bundle.sh' },
      server: { configure: HOOK, units: ['shukkatest-web'], health: 'http://127.0.0.1:3000/' } }],
  }));
  const checkout = gitCheckout(root);
  const ssm = stubSsm(() => ({ Status: 'Failed', ResponseCode: 12, StandardOutputContent: `shukka: shukkatest/web 1111111 -> ${SHA} rolled-back\n` }));
  const s3 = stubClient();
  let stdout = '';
  const out = (t: string) => { stdout += t; };
  const code = await main(
    ['--config', config, '--app', 'web', '--bucket', 'b-bucket', '--sha', SHA, '--checkout', checkout, '--script', scriptFile(root), '--bundle-sha256', BUNDLE_SHA256],
    { ssm: ssm.client, ec2: stubEc2(['i-0aaa']).client, s3: s3.client, pollMs: 0, out },
  );
  assert.equal(code, 12);
  assert.match(stdout, /rolled back; the previous release is live/);
  assert.equal(Buffer.from(s3.calls[0]!.input.Body as Buffer).toString(), GOOD_HOOK);
  const commands = (ssm.calls.find((c) => c instanceof SendCommandCommand)!.input.Parameters as { commands: string[] }).commands;
  const run = spawnSync('sh', ['-c', commands.join('\n')], { encoding: 'utf8' });
  assert.ok(run.stdout.includes('shukkatest-web\n--health\nhttp://127.0.0.1:3000/\n'), run.stdout);
}));

test('shu-mf3: the hook is refused when the checkout is not at the commit being released', withTmp((root) => {
  const checkout = gitCheckout(root);
  const head = headOf(checkout);
  assert.equal(readHook(checkout, HOOK, head).toString(), GOOD_HOOK);
  assert.equal(readHook(checkout, HOOK, head.slice(0, 12)).toString(), GOOD_HOOK);
  const other = head.startsWith('0') ? `1${head.slice(1)}` : `0${head.slice(1)}`;
  assert.throws(() => readHook(checkout, HOOK, other), /not at the commit being released/);
  assert.throws(() => readHook(checkout, HOOK, 'HEAD'), /not at the commit being released/);
}));

test('shu-mf3: health and units carrying { or } are refused, so no {{ssm:...}} reaches Run Command', withTmp(async (root) => {
  const options = baseOptions(root, scriptFile(root));
  const secret = 'http://127.0.0.1:3000/?{{ssm:/shukkatest/prod/SECRET}}';
  assert.ok(checkArgs({ ...options, health: secret }).some((p) => /health: must not contain \{ or \}/.test(p)));
  assert.ok(checkArgs({ ...options, units: ['web', '{{ssm:/x}}'] }).some((p) => /units:/.test(p)));
  assert.deepEqual(checkArgs(options), []);
  const ssm = stubSsm(() => ({ Status: 'Success', ResponseCode: 0 }));
  const s3 = stubClient();
  await assert.rejects(release({ ...options, health: secret, ec2: stubEc2().client, ssm: ssm.client, s3: s3.client, out: () => {} }), /health/);
  assert.equal(ssm.calls.length, 0);
  assert.equal(s3.calls.length, 0);
}));

test('shu-mf3: the failure message shows the last line only when it is the release script result line', withTmp(async (root) => {
  assert.equal(resultLine(`x\nshukka: shukkatest/web none -> ${SHA} rolled-back\n`), `shukka: shukkatest/web none -> ${SHA} rolled-back`);
  assert.equal(resultLine('lots of output cut off in the mid'), 'output truncated');
  assert.equal(resultLine(''), 'output truncated');
  const options = baseOptions(root, scriptFile(root));
  let printed = '';
  await release({ ...options, ec2: stubEc2(['i-0aaa']).client, s3: stubClient().client, out: (t) => { printed += t; },
    ssm: stubSsm(() => ({ Status: 'Failed', ResponseCode: 12, StandardOutputContent: 'a long log, cut off by SSM, ends mid-li' })).client });
  assert.ok(printed.includes(`shukka: release failed on i-0aaa: ${EXIT_MESSAGES[12]} (output truncated)`), printed);
}));

test('shu-9zr: release waits for the SSM agents to report Online before sending, and gives up after the bound', async () => {
  const seen: string[][] = [];
  let polls = 0;
  const ssm = stubClient((command) => {
    seen.push((command.input as { Filters: { Values: string[] }[] }).Filters[0]!.Values);
    polls++;
    return { InstanceInformationList: [{ InstanceId: 'i-1', PingStatus: 'Online' }, { InstanceId: 'i-2', PingStatus: polls < 3 ? 'ConnectionLost' : 'Online' }] };
  });
  let printed = '';
  await waitOnline(ssm.client, ['i-1', 'i-2'], 0, 60, (t) => { printed += t; });
  assert.equal(polls, 3);
  assert.deepEqual(seen[0], ['i-1', 'i-2']);
  assert.match(printed, /waiting for the SSM agent on i-2 to come online/);

  const never = stubClient(() => ({ InstanceInformationList: [] }));
  await assert.rejects(waitOnline(never.client, ['i-9'], 0, 0, () => {}), /SSM agent on i-9 is not online after 0 seconds; nothing was sent/);

  // A role that may not read agent status: say so and let SendCommand report.
  const denied = stubClient(() => { throw Object.assign(new Error('no'), { name: 'AccessDeniedException' }); });
  await waitOnline(denied.client, ['i-1'], 0, 60, () => {});
});

test('shu-9bj.7: release passes --configure-sha256 (of the hook it uploads) and --bundle-sha256 (of the uploaded tarball) to the release script', withTmp(async (root) => {
  const dir = bundleDir(root);
  const s3 = stubClient();
  const uploaded = await upload({ dir, bucket: 'shukkatest-deploy-123', project: 'shukkatest', app: 'web', sha: SHA, s3: s3.client });
  assert.equal(uploaded.sha256, sha256(s3.calls[0]!.input.Body as Buffer));
  const ssm = stubSsm(() => ({ Status: 'Success', ResponseCode: 0 }));
  await release({ ...baseOptions(root, scriptFile(root)), bundleSha256: uploaded.sha256, ec2: stubEc2(['i-0aaa']).client, ssm: ssm.client, s3: s3.client, out: () => {} });
  const hookBody = Buffer.from(s3.calls[1]!.input.Body as Buffer);
  const commands = (ssm.calls.find((c) => c instanceof SendCommandCommand)!.input.Parameters as { commands: string[] }).commands;
  const args = spawnSync('sh', ['-c', commands.join('\n')], { encoding: 'utf8' }).stdout.trim().split('\n');
  assert.equal(args[args.indexOf('--configure-sha256') + 1], sha256(hookBody));
  assert.equal(args[args.indexOf('--bundle-sha256') + 1], uploaded.sha256);
}));

test('shu-9bj.7: release refuses a missing or malformed bundle digest before anything is uploaded or sent', withTmp(async (root) => {
  const options = baseOptions(root, scriptFile(root));
  for (const bad of [undefined, '', 'B'.repeat(64), 'b'.repeat(63)]) {
    const args = { ...options, bundleSha256: bad };
    if (bad === undefined) delete args.bundleSha256;
    assert.ok(checkArgs(args).some((p) => /bundle-sha256/.test(p)), String(bad));
    const ssm = stubSsm(() => ({ Status: 'Success', ResponseCode: 0 }));
    const s3 = stubClient();
    await assert.rejects(release({ ...args, ec2: stubEc2().client, ssm: ssm.client, s3: s3.client, out: () => {} }), /bundle-sha256/);
    assert.equal(ssm.calls.length + s3.calls.length, 0);
  }
  const code = await main(['--project', 'shukkatest', '--app', 'web', '--region', 'us-east-1', '--configure', HOOK, '--units', 'u',
    '--health', 'http://127.0.0.1/', '--bucket', 'b-bucket', '--sha', SHA, '--checkout', options.checkout]);
  assert.equal(code, 2);
}));

test('shu-9bj.15: SC2317 is disabled only on the trap-only cleanup function of box/shukka-release.sh, so older shellcheck (0.9) passes', () => {
  const lines = readFileSync('box/shukka-release.sh', 'utf8').split('\n');
  const at = lines.indexOf('cleanup() {');
  assert.ok(at > 0, 'cleanup() { not found');
  assert.match(lines[at - 1] ?? '', /^# shellcheck disable=(\S*,)?SC2317(,\S*)? /, 'the line above cleanup() disables SC2317');
  assert.ok(lines.slice(at).includes('trap cleanup EXIT'), 'cleanup is the EXIT trap');
  // Nothing broader: no file-wide directive and no other SC2317 in the shellchecked scripts.
  const shellchecked = ['box', 'scripts'].flatMap((dir) => readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.sh')).map((f) => `${dir}/${f}`));
  const hits = shellchecked.flatMap((f) => readFileSync(f, 'utf8').split('\n').map((l, i) => ({ f, i, l })).filter(({ l }) => l.includes('SC2317')));
  assert.deepEqual(hits.map(({ f, i }) => `${f}:${i}`), [`box/shukka-release.sh:${at - 1}`]);
});
