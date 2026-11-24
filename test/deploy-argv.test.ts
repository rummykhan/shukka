// shu-9bj.5: a stack selector or a tag from the (untrusted) cloud assembly must never become a cdk option. These
// tests run infra.yml's own Deploy step script with shukka's pinned cdk (no AWS: no credentials, empty AWS files,
// instance metadata off, every endpoint pointed at a closed port) on the security review's hostile assembly, and
// check whether cdk loaded the planted plugin (it leaves MARKER next to itself).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { cdkBin } from '../scripts/cli/exec.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = join(root, 'test', 'fixtures', 'assembly', 'plugin-selector');
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'shu-9bj.5-argv-')));
after(() => rmSync(scratch, { recursive: true, force: true }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;

/** The JavaScript of infra.yml's deploy job "Deploy" step (the heredoc after `node --input-type=module -`). */
function deploySnippet(): string {
  const infra = parse(readFileSync(join(root, '.github', 'workflows', 'infra.yml'), 'utf8')) as Loose;
  const step = (infra.jobs.deploy.steps as Loose[]).find((s) => s.name === 'Deploy');
  assert.ok(step, 'infra.yml deploy job has a Deploy step');
  const m = /<<'JS'\n([\s\S]*?)\nJS\n/.exec(step.run as string);
  assert.ok(m, 'the Deploy step runs a node heredoc');
  return m[1] as string;
}

/** A copy of the hostile assembly; `manifest` rewrites its manifest (with @ASSEMBLY@ replaced by the copy's path). */
function hostile(manifest?: (m: Loose, dir: string) => void): string {
  const dir = mkdtempSync(join(scratch, 'cdk.out-'));
  cpSync(fixture, dir, { recursive: true });
  const file = join(dir, 'manifest.json');
  const m = JSON.parse(readFileSync(file, 'utf8').replaceAll('@ASSEMBLY@', dir)) as Loose;
  manifest?.(m, dir);
  writeFileSync(file, JSON.stringify(m));
  return dir;
}

/** An environment with no way to reach AWS. */
function offlineEnv(): Record<string, string> {
  const home = mkdtempSync(join(scratch, 'home-'));
  const empty = join(home, 'empty');
  writeFileSync(empty, '');
  return {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: home,
    AWS_CONFIG_FILE: empty,
    AWS_SHARED_CREDENTIALS_FILE: empty,
    AWS_EC2_METADATA_DISABLED: 'true',
    AWS_ENDPOINT_URL: 'http://127.0.0.1:9',
    AWS_REGION: 'us-east-1',
    CDK_DISABLE_VERSION_CHECK: 'true',
    CDK_DISABLE_CLI_TELEMETRY: 'true',
  };
}

/** Run the real Deploy step script with the pinned cdk, from an empty directory. */
function runDeployStep(assembly: string) {
  const cwd = mkdtempSync(join(scratch, 'cwd-'));
  const wrapper = join(scratch, 'cdk');
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${cdkBin()}" "$@"\n`, { mode: 0o755 });
  // The step hands the script shukka's assembly.mjs (deployCommands) and the project (shu-9bj.12).
  const r = spawnSync(process.execPath, ['--input-type=module', '-', assembly, '0123456789abcdef0123456789abcdef01234567', join(root, 'scripts', 'assembly.mjs')], {
    cwd,
    input: deploySnippet(),
    encoding: 'utf8',
    env: { ...offlineEnv(), CDK: wrapper, PROJECT: 'demo', QUALIFIER: 'demo' },
    timeout: 120_000,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

/** The pinned cdk with these arguments, offline, from an empty directory. */
function runRealCdk(args: string[]) {
  const cwd = mkdtempSync(join(scratch, 'cwd-'));
  const r = spawnSync(process.execPath, [cdkBin(), ...args], { cwd, encoding: 'utf8', env: offlineEnv(), timeout: 120_000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test('shu-9bj.5: control: the pinned cdk does load a plugin named by an option-shaped stack selector', () => {
  // Shows the MARKER check sees the attack: the argv the Deploy step built before this fix for the hostile stack.
  const dir = hostile();
  runRealCdk(['deploy', '--app', dir, '--require-approval', 'never', '--no-color', '--exclusively', `--plugin=${dir}/evil.cjs`, '--tags', 'a=1', '--tags', 'shukka:revision=0123']);
  assert.ok(existsSync(join(dir, 'MARKER')), 'cdk read the selector as --plugin and ran evil.cjs');
  // A tag split from its --tags flag is option-shaped too; this cdk stops with a usage error rather than loading
  // it, which is not a protection shukka relies on.
  const split = hostile();
  const r = runRealCdk(['deploy', '--app', split, '--require-approval', 'never', '--no-color', '--exclusively', 'Demo2', '--tags', `--plugin=${split}/evil.cjs`, '--tags', 'shukka:revision=0123']);
  assert.doesNotMatch(r.out, /Synthesis time/, 'the split tag did not reach cdk as data');
});

test('shu-9bj.5: infra.yml Deploy re-checks each stack selector and refuses --plugin=<path> before cdk runs', () => {
  const dir = hostile();
  const r = runDeployStep(dir);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /::error::shukka: .*stack selector.*--plugin=/);
  assert.ok(!existsSync(join(dir, 'MARKER')), `the planted plugin ran:\n${r.out}`);
  assert.doesNotMatch(r.out, /Synthesis time/, 'cdk was never started');
});

test('shu-9bj.5: infra.yml Deploy refuses a selector with a newline or a leading dash in the stack id too', () => {
  for (const bad of ['-x', 'Demo\nevil', '']) {
    const dir = hostile((m) => {
      delete m.artifacts.Demo.displayName;
      m.artifacts[bad] = m.artifacts.Demo;
      delete m.artifacts.Demo;
    });
    const r = runDeployStep(dir);
    assert.notEqual(r.code, 0, `${JSON.stringify(bad)}: ${r.out}`);
    assert.match(r.out, /stack selector/);
    assert.doesNotMatch(r.out, /Synthesis time/);
  }
});

test('shu-9bj.5: infra.yml Deploy passes each tag as one --tags=k=v token, so a tag --plugin=x stays data for the pinned cdk', () => {
  const dir = hostile((m, at) => {
    m.artifacts.Demo.displayName = 'Demo';
    m.artifacts.Demo.properties.tags = { '--plugin': `${at}/evil.cjs` };
  });
  const r = runDeployStep(dir);
  assert.ok(!existsSync(join(dir, 'MARKER')), `the planted plugin ran:\n${r.out}`);
  assert.match(r.out, /Synthesis time/, 'cdk started and read the assembly');
  assert.notEqual(r.code, 0, 'offline, the deploy itself fails');
  assert.match(r.out, /::error::shukka: cdk deploy failed/);
});

test('shu-9bj.5: the stacks output is written only from assembly.mjs stacks succeeding, under set -e, in both jobs', () => {
  const infra = parse(readFileSync(join(root, '.github', 'workflows', 'infra.yml'), 'utf8')) as Loose;
  for (const [job, name] of [['changes', 'List the stacks'], ['deploy', 'Check the assembly']]) {
    const run = ((infra.jobs[job as string].steps as Loose[]).find((s) => s.name === name) as Loose).run as string;
    assert.match(run, /^set -euo pipefail$/m, `${job}: ${name}`);
    // An assignment fails the step when the command fails; `echo "stacks=$(...)"` would write an empty value instead.
    assert.match(run, /^stacks=\$\(node \.shukka\/scripts\/assembly\.mjs stacks "\$RUNNER_TEMP\/cdk\.out"\)$/m, `${job}: ${name}`);
    assert.doesNotMatch(run, /echo "stacks=\$\(/, `${job}: ${name}`);
  }
});
