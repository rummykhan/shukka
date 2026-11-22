// The shukka CLI (shu-5ix): bootstrap --account, bootstrap <project>, diff, deploy, --help; and the fence object
// in shukka.json that bootstrap reads. AWS, GitHub and cdk are never called: AWS reads go through a fake `Aws`,
// commands through a recording spawn, and the bootstrap commands are checked in dry-run output.
/* eslint-disable @typescript-eslint/no-explicit-any -- SDK commands and fakes are loosely typed on purpose */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateConfig } from '../scripts/config.mjs';
import { COMMANDS, helpText, main } from '../scripts/cli/main.mjs';
import { realSpawn } from '../scripts/cli/exec.mjs';
import { CDK_CLI } from '../scripts/cli/bootstrap.mjs';
import { bundleDir, stubClient } from './helpers/release-fixtures.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ACCOUNT = '123456789012';
const OWNER = `arn:aws:iam::${ACCOUNT}:user/personal-root-user`;
const ZONE = 'Z0123456789ABCDEFGHIJ';
const OIDC = `arn:aws:iam::${ACCOUNT}:oidc-provider/token.actions.githubusercontent.com`;

type Call = { cmd: string; args: string[]; options: any };
type Fake = Record<string, any>;

function configJson(mutate: (c: any) => void = () => {}) {
  const c: any = {
    project: 'shukkatest',
    qualifier: 'shukkatest',
    aws: { account: ACCOUNT, region: 'us-east-1' },
    checks: [{ name: 'unit', dir: 'app', run: ['npm test'] }],
    infra: { dir: 'infra', paths: ['infra/**'] },
    apps: [{
      name: 'web',
      paths: ['app/**'],
      build: { dir: 'app', run: ['npm ci', 'npm run build'], bundle: 'scripts/bundle.sh', env: { APP_URL: 'https://example.com' }, buildEnv: ['LEGAL_ENTITY', 'CONTACT_EMAIL'] },
      server: { configure: 'box/configure-web.sh', units: ['shukkatest-web'], health: 'http://127.0.0.1:3000/' },
    }],
    smoke: { run: 'bash smoke.sh' },
    fence: { hostedZoneIds: [ZONE], mailDomains: ['example.com'] },
  };
  mutate(c);
  return c;
}

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function git(dir: string, ...args: string[]) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
}

/** A consumer repository with shukka.json, pushed to a local bare origin: a clean clone at origin/main. */
function consumer(tmp: string, mutate?: (c: any) => void): { dir: string; sha: string } {
  const origin = join(tmp, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const dir = join(tmp, 'consumer');
  mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  write(join(dir, 'shukka.json'), `${JSON.stringify(configJson(mutate), null, 2)}\n`);
  write(join(dir, 'app', 'package.json'), '{}\n');
  write(join(dir, 'infra', 'package.json'), '{}\n');
  write(join(dir, 'box', 'configure-web.sh'), '#!/usr/bin/env bash\necho configured\n');
  write(join(dir, 'smoke.sh'), 'exit 0\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'consumer');
  git(dir, 'remote', 'add', 'origin', origin);
  git(dir, 'push', '-q', '-u', 'origin', 'main');
  return { dir, sha: git(dir, 'rev-parse', 'HEAD') };
}

function withTmp(fn: (tmp: string) => Promise<void> | void) {
  return async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'shu-5ix-'));
    try {
      await fn(tmp);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  };
}

const PARAMETERS: Record<string, { type: string; value: string }> = {
  '/shukkatest/prod/LEGAL_ENTITY': { type: 'String', value: 'Example Ltd' },
  '/shukkatest/prod/CONTACT_EMAIL': { type: 'String', value: 'hello@example.com' },
};

/** A fake of every AWS read the CLI makes; `over` replaces single reads. */
function fakeAws(over: Fake = {}) {
  const reads: string[] = [];
  const base: Fake = {
    callerArn: async () => ({ account: ACCOUNT, arn: OWNER }),
    roleArn: async (name: string) => `arn:aws:iam::${ACCOUNT}:role/admins/${name}`,
    describeStack: async () => null,
    stackResourceIds: async () => [],
    listStackNames: async () => [],
    getParameter: async (name: string) => PARAMETERS[name] ?? null,
    privateTypes: async () => [],
    unboundedRoles: async () => [],
    oidcProviders: async () => [],
    clients: () => { throw new Error('no AWS clients in this test'); },
    ...over,
  };
  const aws: Fake = {};
  for (const [k, f] of Object.entries(base)) {
    aws[k] = (...args: any[]) => {
      reads.push(`${k}(${args.map((a) => JSON.stringify(a)).join(',')})`);
      return f(...args);
    };
  }
  return { aws, reads };
}

/** A recording spawn: git runs for real (on test repositories), everything else is answered by `respond`. */
function recordingSpawn(respond: (call: Call) => { status: number; stdout: string } = () => ({ status: 0, stdout: '' })) {
  const calls: Call[] = [];
  const spawn = (cmd: string, args: string[], options: any) => {
    calls.push({ cmd, args, options });
    if (cmd === 'git') return realSpawn(cmd, args, { ...options, capture: options.capture || 'stdout' });
    return respond({ cmd, args, options });
  };
  return { calls, spawn };
}

async function cli(argv: string[], opts: { aws?: Fake; spawn?: any; cwd?: string; env?: Record<string, string> } = {}) {
  let out = '';
  let err = '';
  const code = await main(argv, {
    out: (t: string) => { out += t; },
    err: (t: string) => { err += t; },
    ...(opts.spawn ? { spawn: opts.spawn } : {}),
    aws: () => (opts.aws ?? fakeAws().aws) as any,
    cwd: opts.cwd ?? root,
    env: opts.env ?? {},
  });
  return { code, out, err };
}

/** The commands printed with `+ `, in order. */
function printed(out: string): string[] {
  return out.split('\n').filter((l) => l.startsWith('+ '));
}

/** The value after `flag` in a printed command line. */
function argAfter(line: string, flag: string): string {
  const words = line.split(/\s+/);
  const i = words.indexOf(flag);
  assert.ok(i !== -1, `${flag} in ${line}`);
  return words[i + 1] as string;
}

function templateOf(assembly: string, stack: string): any {
  return JSON.parse(readFileSync(join(assembly, `${stack}.template.json`), 'utf8'));
}

const MUTATING = (calls: Call[]) => calls.filter((c) => c.cmd !== 'git' && !(c.cmd === 'aws' && c.args[0] === 'sts'));

// ---------- shukka.json fence object ----------

test('shu-5ix: shukka.json takes an optional fence object with hosted zone ids and mail domains', () => {
  const ok = validateConfig(configJson());
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.config!.fence, { hostedZoneIds: [ZONE], mailDomains: ['example.com'] });

  const none = validateConfig(configJson((c) => { delete c.fence; }));
  assert.deepEqual(none.problems, []);
  assert.deepEqual(none.config!.fence, { hostedZoneIds: [], mailDomains: [] });

  const cases: [(c: any) => void, RegExp][] = [
    [(c) => { c.fence.hostedZoneIds = ['zone1']; }, /^shukka\.json: fence\.hostedZoneIds\[0\]: /],
    [(c) => { c.fence.mailDomains = ['*.example.com']; }, /^shukka\.json: fence\.mailDomains\[0\]: /],
    [(c) => { c.fence.zones = []; }, /^shukka\.json: fence\.zones: unknown key/],
    [(c) => { c.fence = ['Z1']; }, /^shukka\.json: fence: expected object/],
  ];
  for (const [mutate, expected] of cases) {
    const { config, problems } = validateConfig(configJson(mutate));
    assert.equal(config, null);
    assert.ok(problems.some((p: string) => expected.test(p)), `${expected} in ${problems.join(' | ')}`);
  }
});

// ---------- bootstrap --account ----------

test('shu-5ix: bootstrap --account dry run prints the cdk deploy of Shukka-Account with the caller profile and changes nothing', withTmp(async () => {
  const { calls, spawn } = recordingSpawn();
  const r = await cli(['bootstrap', '--account', '--profile', 'stelking', '--region', 'us-east-1', '--dry-run'], { spawn });
  assert.equal(r.code, 0, r.err);
  const lines = printed(r.out);
  const deploy = lines.find((l) => l.includes(' deploy Shukka-Account'));
  assert.ok(deploy, r.out);
  assert.match(deploy, new RegExp(`^\\+ npx --yes ${CDK_CLI.replace(/\./g, '\\.')} deploy Shukka-Account --app \\S+ --require-approval never --no-color --profile stelking\\s+\\[dry run: not run\\]$`));
  assert.deepEqual(MUTATING(calls), [], 'nothing but lookups ran');
  const template = templateOf(argAfter(deploy, '--app'), 'Shukka-Account');
  const types = Object.values(template.Resources).map((x: any) => x.Type);
  assert.ok(types.includes('AWS::IAM::OIDCProvider'), 'a new account creates the provider');
  assert.equal(template.Outputs.Projects.Value, 'none');
  assert.equal(template.Parameters?.BootstrapVersion, undefined, 'needs no CDK bootstrap of its own');
}));

test('shu-5ix: bootstrap --account imports an existing OIDC provider with --oidc-provider-arn and never creates one', async () => {
  const r = await cli(['bootstrap', '--account', '--oidc-provider-arn', OIDC, '--region', 'us-east-1', '--dry-run'], {
    aws: fakeAws({ oidcProviders: async () => [OIDC] }).aws,
  });
  assert.equal(r.code, 0, r.err);
  const deploy = printed(r.out).find((l) => l.includes(' deploy Shukka-Account'))!;
  const template = templateOf(argAfter(deploy, '--app'), 'Shukka-Account');
  assert.ok(!Object.values(template.Resources).some((x: any) => x.Type === 'AWS::IAM::OIDCProvider'));
  assert.equal(template.Outputs.OidcProviderArn.Value, OIDC);
});

test('shu-5ix: bootstrap --account refuses to create a second GitHub provider, and a provider ARN from another account', async () => {
  const exists = await cli(['bootstrap', '--account', '--region', 'us-east-1', '--dry-run'], { aws: fakeAws({ oidcProviders: async () => [OIDC] }).aws });
  assert.equal(exists.code, 1);
  assert.match(exists.err, /already has a GitHub OIDC provider .*--oidc-provider-arn/);
  assert.deepEqual(printed(exists.out), [], 'no command was printed, so none ran');

  const other = await cli(['bootstrap', '--account', '--oidc-provider-arn', OIDC.replace(ACCOUNT, '999999999999'), '--region', 'us-east-1', '--dry-run']);
  assert.equal(other.code, 1);
  assert.match(other.err, /in account 999999999999/);
});

test('shu-5ix: bootstrap --account keeps the deployed project list and the imported provider', async () => {
  const account = { name: 'Shukka-Account', outputs: { Projects: 'trendigle,orbitary', OidcProviderArn: OIDC }, tags: {} };
  const r = await cli(['bootstrap', '--account', '--region', 'us-east-1', '--dry-run'], {
    aws: fakeAws({ describeStack: async (n: string) => (n === 'Shukka-Account' ? account : null), stackResourceIds: async () => ['Placeholder'] }).aws,
  });
  assert.equal(r.code, 0, r.err);
  const template = templateOf(argAfter(printed(r.out).find((l) => l.includes('deploy Shukka-Account'))!, '--app'), 'Shukka-Account');
  assert.equal(template.Outputs.Projects.Value, 'trendigle,orbitary');
  assert.equal(template.Outputs.OidcProviderArn.Value, OIDC);

  const clash = await cli(['bootstrap', '--account', '--projects', 'trendigle,trendigle2', '--region', 'us-east-1', '--dry-run']);
  assert.equal(clash.code, 1);
  assert.match(clash.err, /prefix/);
});

// ---------- bootstrap <project> ----------

function projectArgs(extra: string[] = []) {
  return ['bootstrap', 'shukkatest', '--config', 'shukka.json', '--repo', 'owner/consumer', '--profile', 'stelking', '--region', 'us-east-1', '--dry-run', ...extra];
}

test('shu-5ix: bootstrap <project> dry run deploys the boundary stack, then the project bootstrap, then copies buildEnv to GitHub', withTmp(async (tmp) => {
  const { dir } = consumer(tmp);
  const { calls, spawn } = recordingSpawn();
  const { aws } = fakeAws();
  const r = await cli(projectArgs(), { spawn, aws, cwd: dir });
  assert.equal(r.code, 0, r.err);
  const lines = printed(r.out);
  const boundary = lines.findIndex((l) => l.includes('deploy Shukka-Boundary-shukkatest'));
  const toolkit = lines.findIndex((l) => l.startsWith('+ aws cloudformation deploy'));
  const vars = lines.map((l, i) => (l.startsWith('+ gh variable set') ? i : -1)).filter((i) => i !== -1);
  assert.ok(boundary !== -1 && toolkit > boundary && vars.length === 2 && vars[0]! > toolkit, r.out);

  // 1. The fence: boundary and the three execution policies, with the config's hosted zone and mail domain.
  const boundaryLine = lines[boundary]!;
  assert.match(boundaryLine, /--profile stelking/);
  const fence = templateOf(argAfter(boundaryLine, '--app'), 'Shukka-Boundary-shukkatest');
  const names = Object.values(fence.Resources).filter((x: any) => x.Type === 'AWS::IAM::ManagedPolicy').map((x: any) => x.Properties.ManagedPolicyName).sort();
  assert.deepEqual(names, ['shukkatest-shukka-boundary', 'shukkatest-shukka-execution', 'shukkatest-shukka-execution-iam', 'shukkatest-shukka-execution-infra']);
  assert.match(JSON.stringify(fence), new RegExp(`hostedzone/${ZONE}`));
  assert.match(JSON.stringify(fence), /identity\/example\.com/);

  // 2. The bootstrap: CDKToolkit-<qualifier>, never the default CDKToolkit; all three execution policies; the caller as emergency principal.
  const toolkitLine = lines[toolkit]!;
  assert.equal(argAfter(toolkitLine, '--stack-name'), 'CDKToolkit-shukkatest');
  assert.ok(!/--stack-name CDKToolkit(\s|$)/.test(r.out));
  for (const flag of ['--capabilities CAPABILITY_NAMED_IAM', '--tags shukka:project=shukkatest', '--region us-east-1', '--profile stelking']) {
    assert.ok(toolkitLine.includes(flag), `${flag} in ${toolkitLine}`);
  }
  const template = JSON.parse(readFileSync(argAfter(toolkitLine, '--template-file'), 'utf8'));
  const exec = template.Resources.CloudFormationExecutionRole.Properties.ManagedPolicyArns.map((a: any) => a['Fn::Sub']);
  assert.deepEqual(exec.map((a: string) => a.split('policy/')[1]), ['shukkatest-shukka-execution', 'shukkatest-shukka-execution-infra', 'shukkatest-shukka-execution-iam']);
  assert.equal(template.Resources.CdkBootstrapVersion.Properties.Name, '/cdk-bootstrap/shukkatest/version');
  const trust = template.Resources.DeploymentActionRole.Properties.AssumeRolePolicyDocument.Statement[0].Condition.ArnLike['aws:PrincipalArn'];
  assert.ok(trust.includes(OWNER), 'the caller may deploy from a laptop');

  // 3. buildEnv values from Parameter Store to repository variables, never printed.
  assert.deepEqual(lines.filter((l) => l.startsWith('+ gh')).map((l) => l.replace(/\s+\[dry run: not run\]$/, '')), [
    '+ gh variable set LEGAL_ENTITY --repo owner/consumer < value of /shukkatest/prod/LEGAL_ENTITY',
    '+ gh variable set CONTACT_EMAIL --repo owner/consumer < value of /shukkatest/prod/CONTACT_EMAIL',
  ]);
  assert.ok(!r.out.includes('Example Ltd') && !r.err.includes('hello@example.com'));

  assert.deepEqual(MUTATING(calls), [], 'a dry run changes nothing');
  assert.match(r.err, /Shukka-Account does not exist/);
}));

test('shu-5ix: bootstrap <project> real run hands each buildEnv value to gh on stdin', withTmp(async (tmp) => {
  const { dir } = consumer(tmp);
  const { calls, spawn } = recordingSpawn();
  const r = await cli(projectArgs().filter((a) => a !== '--dry-run'), { spawn, cwd: dir });
  assert.equal(r.code, 0, r.err);
  const gh = calls.filter((c) => c.cmd === 'gh');
  assert.deepEqual(gh.map((c) => [c.args, c.options.input]), [
    [['variable', 'set', 'LEGAL_ENTITY', '--repo', 'owner/consumer'], 'Example Ltd'],
    [['variable', 'set', 'CONTACT_EMAIL', '--repo', 'owner/consumer'], 'hello@example.com'],
  ]);
  assert.deepEqual(calls.filter((c) => c.cmd !== 'git' && c.cmd !== 'gh').map((c) => `${c.cmd} ${c.args.slice(0, 4).join(' ')}`), [
    `npx --yes ${CDK_CLI} deploy Shukka-Boundary-shukkatest`,
    'aws cloudformation deploy --stack-name CDKToolkit-shukkatest',
  ]);
}));

test('shu-5ix: bootstrap <project> takes the hosted zone and mail domain from flags over shukka.json', withTmp(async (tmp) => {
  const { dir } = consumer(tmp, (c) => { delete c.fence; });
  const none = await cli(projectArgs(), { cwd: dir });
  assert.equal(none.code, 1);
  assert.match(none.err, /exactly one hosted zone/);

  const r = await cli(projectArgs(['--hosted-zone-id', 'ZFLAG123', '--mail-domain', 'mail.example.org']), { cwd: dir });
  assert.equal(r.code, 0, r.err);
  const fence = JSON.stringify(templateOf(argAfter(printed(r.out).find((l) => l.includes('Shukka-Boundary'))!, '--app'), 'Shukka-Boundary-shukkatest'));
  assert.match(fence, /hostedzone\/ZFLAG123/);
  assert.match(fence, /identity\/mail\.example\.org/);
}));

test('shu-5ix: emergency principals default to the caller (an assumed role resolves to its role ARN) and --emergency-principal overrides', withTmp(async (tmp) => {
  const { dir } = consumer(tmp);
  const trustOf = (out: string) => {
    const file = argAfter(printed(out).find((l) => l.startsWith('+ aws cloudformation deploy'))!, '--template-file');
    return JSON.parse(readFileSync(file, 'utf8')).Resources.DeploymentActionRole.Properties.AssumeRolePolicyDocument.Statement[0].Condition.ArnLike['aws:PrincipalArn'];
  };
  const assumed = fakeAws({ callerArn: async () => ({ account: ACCOUNT, arn: `arn:aws:sts::${ACCOUNT}:assumed-role/Admin/rehan` }) });
  const a = await cli(projectArgs(), { cwd: dir, aws: assumed.aws });
  assert.equal(a.code, 0, a.err);
  assert.ok(trustOf(a.out).includes(`arn:aws:iam::${ACCOUNT}:role/admins/Admin`));

  const other = `arn:aws:iam::${ACCOUNT}:role/break-glass`;
  const o = await cli(projectArgs(['--emergency-principal', other]), { cwd: dir });
  assert.equal(o.code, 0, o.err);
  assert.ok(trustOf(o.out).includes(other));
  assert.ok(!trustOf(o.out).includes(OWNER));

  const rootCaller = fakeAws({ callerArn: async () => ({ account: ACCOUNT, arn: `arn:aws:iam::${ACCOUNT}:root` }) });
  const rt = await cli(projectArgs(), { cwd: dir, aws: rootCaller.aws });
  assert.equal(rt.code, 1);
  assert.match(rt.err, /--emergency-principal/);
}));

test('shu-5ix: bootstrap <project> adds the project to Shukka-Account when it exists', withTmp(async (tmp) => {
  const { dir } = consumer(tmp);
  const account = { name: 'Shukka-Account', outputs: { Projects: 'trendigle', OidcProviderArn: OIDC }, tags: {} };
  const r = await cli(projectArgs(), {
    cwd: dir,
    aws: fakeAws({ describeStack: async (n: string) => (n === 'Shukka-Account' ? account : null), stackResourceIds: async () => ['Placeholder'] }).aws,
  });
  assert.equal(r.code, 0, r.err);
  const line = printed(r.out).find((l) => l.includes('deploy Shukka-Account'));
  assert.ok(line, r.out);
  const template = templateOf(argAfter(line, '--app'), 'Shukka-Account');
  assert.equal(template.Outputs.Projects.Value, 'trendigle,shukkatest');
  assert.equal(template.Outputs.OidcProviderArn.Value, OIDC);
}));

test('shu-5ix: bootstrap <project> refuses before changing anything', withTmp(async (tmp) => {
  const cases: { name: string; mutate?: (c: any) => void; aws?: Fake; args?: string[]; expect: RegExp }[] = [
    { name: 'a known project prefixed by this one', aws: { listStackNames: async () => ['Shukka-Boundary-shukkatestx'] }, expect: /"shukkatest" is a prefix of known project "shukkatestx"/ },
    { name: 'a known project prefixing this one', aws: { describeStack: async (n: string) => (n === 'Shukka-Account' ? { name: n, outputs: { Projects: 'shukkate' }, tags: {} } : null) }, expect: /known project "shukkate" is a prefix of "shukkatest"/ },
    { name: "CDK's default qualifier", mutate: (c) => { c.qualifier = 'hnb659fds'; }, expect: /hnb659fds is CDK's default bootstrap/ },
    { name: 'a qualifier bootstrapped by something else', aws: { getParameter: async (n: string) => (n === '/cdk-bootstrap/shukkatest/version' ? { type: 'String', value: '21' } : PARAMETERS[n] ?? null) }, expect: /qualifier shukkatest is already bootstrapped/ },
    { name: 'a toolkit stack shukka did not make', aws: { describeStack: async (n: string) => (n === 'CDKToolkit-shukkatest' ? { name: n, outputs: {}, tags: {} } : null) }, expect: /CDKToolkit-shukkatest exists and was not made by shukka/ },
    { name: 'a private CloudFormation type', aws: { privateTypes: async () => [{ kind: 'RESOURCE', typeName: 'Acme::Admin::Thing', executionRoleArn: `arn:aws:iam::${ACCOUNT}:role/acme-admin` }] }, expect: /Acme::Admin::Thing runs as arn:aws:iam::123456789012:role\/acme-admin[\s\S]*--allow-private-types/ },
    { name: 'a role in the prefix without the boundary', aws: { unboundedRoles: async () => [{ roleName: 'shukkatest-old', arn: `arn:aws:iam::${ACCOUNT}:role/shukkatest-old` }] }, expect: /role arn:aws:iam::123456789012:role\/shukkatest-old matches the shukkatest prefix but has no permissions boundary/ },
    { name: 'a buildEnv parameter that does not exist', aws: { getParameter: async () => null }, expect: /buildEnv LEGAL_ENTITY: parameter \/shukkatest\/prod\/LEGAL_ENTITY does not exist/ },
    { name: 'a secret buildEnv parameter', aws: { getParameter: async (n: string) => (n.startsWith('/shukkatest/prod/') ? { type: 'SecureString', value: 'x' } : null) }, expect: /SecureString/ },
    { name: 'credentials for another account', aws: { callerArn: async () => ({ account: '999999999999', arn: 'arn:aws:iam::999999999999:user/x' }) }, expect: /account 999999999999/ },
    { name: 'a project argument that is not the config', args: ['bootstrap', 'other', '--repo', 'owner/consumer', '--dry-run'], expect: /project "other" is not the project/ },
    { name: 'a region that is not the config', args: ['bootstrap', 'shukkatest', '--region', 'eu-west-1', '--repo', 'owner/consumer'], expect: /--region eu-west-1 is not the region/ },
  ];
  for (const [i, c] of cases.entries()) {
    const sub = join(tmp, String(i));
    mkdirSync(sub);
    const { dir } = consumer(sub, c.mutate);
    const { calls, spawn } = recordingSpawn();
    const r = await cli(c.args ?? projectArgs().filter((a) => a !== '--dry-run'), { cwd: dir, spawn, aws: fakeAws(c.aws).aws });
    assert.equal(r.code, 1, `${c.name}: ${r.out}${r.err}`);
    assert.match(r.err, c.expect, c.name);
    assert.deepEqual(MUTATING(calls), [], `${c.name}: nothing ran`);
  }
}));

test('shu-5ix: --allow-private-types reports each private type with its execution role and goes ahead', withTmp(async (tmp) => {
  const { dir } = consumer(tmp);
  const r = await cli(projectArgs(['--allow-private-types']), {
    cwd: dir, aws: fakeAws({ privateTypes: async () => [{ kind: 'MODULE', typeName: 'Acme::Net::Vpc::MODULE', executionRoleArn: null }] }).aws,
  });
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /warning: private CloudFormation module Acme::Net::Vpc::MODULE runs as no execution role/);
}));

test('shu-5ix: project names that are prefixes of reserved names are refused (access-8)', withTmp(async (tmp) => {
  const { dir } = consumer(tmp, (c) => { c.project = 'aw'; c.qualifier = 'aw'; });
  const r = await cli(['bootstrap', 'aw', '--repo', 'owner/consumer', '--dry-run'], { cwd: dir });
  assert.equal(r.code, 1);
  assert.match(r.err, /project name "aw" is reserved \(aws\)/);
}));

// ---------- diff and deploy: refusals ----------

test('shu-5ix: diff and deploy refuse a dirty working tree, an untracked file, and a HEAD that is not origin/main', withTmp(async (tmp) => {
  for (const command of ['diff', 'deploy']) {
    const sub = join(tmp, command);
    mkdirSync(sub);
    const { dir } = consumer(sub);

    write(join(dir, 'app', 'package.json'), '{"changed":true}\n');
    let s = recordingSpawn();
    let r = await cli([command, '--profile', 'stelking'], { cwd: dir, spawn: s.spawn });
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.err, /refusing: the working tree is not clean/);
    assert.deepEqual(MUTATING(s.calls), [], `${command}: nothing ran on a dirty tree`);
    git(dir, 'checkout', '--', 'app/package.json');

    write(join(dir, 'notes.txt'), 'scratch\n');
    s = recordingSpawn();
    r = await cli([command], { cwd: dir, spawn: s.spawn });
    assert.equal(r.code, 1);
    assert.match(r.err, /not clean .*notes\.txt/);
    rmSync(join(dir, 'notes.txt'));

    write(join(dir, 'smoke.sh'), 'exit 1\n');
    git(dir, 'commit', '-q', '-am', 'local only');
    s = recordingSpawn();
    r = await cli([command], { cwd: dir, spawn: s.spawn });
    assert.equal(r.code, 1);
    assert.match(r.err, /refusing: HEAD \([0-9a-f]{12}\) is not origin\/main/);
    assert.deepEqual(MUTATING(s.calls), [], `${command}: nothing ran ahead of origin/main`);

    git(dir, 'remote', 'remove', 'origin');
    s = recordingSpawn();
    r = await cli([command], { cwd: dir, spawn: s.spawn });
    assert.equal(r.code, 1);
    assert.match(r.err, /no origin\/main/);
  }
}));

// ---------- deploy and diff: the workflow steps ----------

const CLEAN_DIFF = 'Stack shukkatest-App\nThere were no differences\n\n✨  Number of stacks with differences: 0\n';
const DESTRUCTIVE_DIFF = 'Stack shukkatest-App\nResources\n[-] AWS::EC2::Instance Box Box1234 destroy\n\n✨  Number of stacks with differences: 1\n';

test('shu-5ix: deploy dry run prints the workflow steps in order: checks, build, synth, diff, guard, cdk deploy with the revision, upload, release, smoke', withTmp(async (tmp) => {
  const { dir, sha } = consumer(tmp);
  const { calls, spawn } = recordingSpawn();
  const r = await cli(['deploy', '--profile', 'stelking', '--dry-run'], { cwd: dir, spawn, aws: fakeAws().aws });
  assert.equal(r.code, 0, r.err);
  const lines = printed(r.out).filter((l) => !l.includes(' git ')).map((l) => l.replace(/^\+ (\(in \S+\) )?/, '').replace(/\s+\[dry run: not run\]$/, ''));
  const order = [
    /^bash -eo pipefail -c 'npm test'$/,
    /^bash -eo pipefail -c 'npm ci'$/,
    /^bash -eo pipefail -c 'npm run build'$/,
    /^bash \S+\/scripts\/bundle\.sh$/,
    /^npm ci$/,
    /^npx --no-install cdk synth --quiet --output \S+$/,
    /^npx --no-install cdk diff --app \S+ --no-color --profile stelking$/,
    /^node scripts\/guard\.mjs < the diff$/,
    new RegExp(`^npx --no-install cdk deploy --app \\S+ --require-approval never --no-color --all --tags shukka:revision=${sha} --profile stelking$`),
    new RegExp(`^upload .* to s3://shukkatest-deploy-${ACCOUNT}/shukkatest/web/${sha}\\.tgz \\(scripts/upload\\.mjs\\)$`),
    new RegExp(`^release shukkatest/web ${sha} on instances tagged Project=shukkatest \\(scripts/release\\.mjs\\)$`),
    /^bash -c 'bash smoke\.sh'$/,
  ];
  assert.equal(lines.length, order.length, lines.join('\n'));
  order.forEach((re, i) => assert.match(lines[i]!, re));
  assert.deepEqual(MUTATING(calls), [], 'a dry run changes nothing');
}));

/** A spawn for a real deploy run: commands succeed, cdk synth writes a manifest, cdk diff prints `diff`, the bundle script prints `bundle`. */
function deploySpawn(diff: string, bundle: string) {
  return recordingSpawn(({ cmd, args }) => {
    if (cmd === 'npx' && args.includes('synth')) {
      const out = args[args.indexOf('--output') + 1]!;
      write(join(out, 'manifest.json'), JSON.stringify({ artifacts: { 'shukkatest-App': { type: 'aws:cloudformation:stack', properties: { tags: { Project: 'shukkatest' } } } } }));
      return { status: 0, stdout: '' };
    }
    if (cmd === 'npx' && args.includes('diff')) return { status: 0, stdout: diff };
    if (cmd === 'bash' && args[0]?.endsWith('bundle.sh')) return { status: 0, stdout: `building\n${bundle}\n` };
    return { status: 0, stdout: '' };
  });
}

function releaseClients() {
  const s3 = stubClient();
  const ec2 = stubClient(() => ({ Reservations: [{ Instances: [{ InstanceId: 'i-0abc' }] }] }));
  const ssm = stubClient((c) => (c.constructor.name === 'SendCommandCommand'
    ? { Command: { CommandId: 'cmd-1' } }
    : { Status: 'Success', ResponseCode: 0, StandardOutputContent: 'shukka: shukkatest/web old -> new live\n' }));
  return { s3, ec2, ssm };
}

test('shu-5ix: deploy runs the guard on the cdk diff, deploys with the revision tag, then uploads and releases through the shared modules', withTmp(async (tmp) => {
  const { dir, sha } = consumer(tmp);
  const bundle = bundleDir(tmp);
  const { calls, spawn } = deploySpawn(CLEAN_DIFF, bundle);
  const c = releaseClients();
  const { aws } = fakeAws({ clients: () => ({ s3: c.s3.client, ssm: c.ssm.client, ec2: c.ec2.client }) });
  const r = await cli(['deploy', '--profile', 'stelking'], { cwd: dir, spawn, aws, env: {} });
  assert.equal(r.code, 0, r.out + r.err);

  const build = calls.find((x) => x.cmd === 'bash' && x.args.includes('npm run build'))!;
  assert.equal(build.options.env.APP_URL, 'https://example.com');
  assert.equal(build.options.env.LEGAL_ENTITY, 'Example Ltd', 'buildEnv from Parameter Store when not in the environment');

  assert.match(r.out, /guard: nothing is deleted or replaced/);
  const deploy = calls.find((x) => x.cmd === 'npx' && x.args.includes('deploy'))!;
  assert.deepEqual(deploy.args.slice(deploy.args.indexOf('--all')), ['--all', '--tags', 'Project=shukkatest', '--tags', `shukka:revision=${sha}`, '--profile', 'stelking']);

  const puts = c.s3.calls.map((x) => x.input.Key);
  assert.deepEqual(puts, [`shukkatest/web/${sha}.tgz`, `shukkatest/web/${sha}.configure.sh`]);
  assert.equal(c.s3.calls[0]!.input.Bucket, `shukkatest-deploy-${ACCOUNT}`);
  assert.equal(c.s3.calls[1]!.input.Body.toString(), '#!/usr/bin/env bash\necho configured\n', 'the hook comes from git');
  const send = c.ssm.calls.find((x) => x.constructor.name === 'SendCommandCommand')!;
  assert.deepEqual(send.input.InstanceIds, ['i-0abc']);
  assert.ok(calls.some((x) => x.cmd === 'bash' && x.args[1] === 'bash smoke.sh'), 'smoke ran');
}));

test('shu-5ix: deploy stops at the guard on a destructive diff unless --allow-replacement, and takes buildEnv from the environment', withTmp(async (tmp) => {
  const { dir } = consumer(tmp);
  const bundle = bundleDir(tmp);
  let s = deploySpawn(DESTRUCTIVE_DIFF, bundle);
  const env = { LEGAL_ENTITY: 'From Env', CONTACT_EMAIL: 'env@example.com' };
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    let c = releaseClients();
    let r = await cli(['deploy', '--skip-checks'], { cwd: dir, spawn: s.spawn, aws: fakeAws({ clients: () => ({ s3: c.s3.client, ssm: c.ssm.client, ec2: c.ec2.client }) }).aws });
    assert.equal(r.code, 1);
    assert.match(r.out, /\[-\] AWS::EC2::Instance Box/);
    assert.match(r.err, /the guard stopped the deploy.*--allow-replacement/);
    assert.match(r.err, /warning: --skip-checks/);
    assert.ok(!s.calls.some((x) => x.args.includes('npm test')), 'checks skipped');
    assert.ok(!s.calls.some((x) => x.cmd === 'npx' && x.args.includes('deploy')), 'no cdk deploy');
    assert.equal(c.s3.calls.length, 0, 'nothing uploaded');
    assert.equal(s.calls.find((x) => x.args.includes('npm run build'))!.options.env.LEGAL_ENTITY, 'From Env');

    s = deploySpawn(DESTRUCTIVE_DIFF, bundle);
    c = releaseClients();
    r = await cli(['deploy', '--skip-checks', '--allow-replacement'], { cwd: dir, spawn: s.spawn, aws: fakeAws({ clients: () => ({ s3: c.s3.client, ssm: c.ssm.client, ec2: c.ec2.client }) }).aws });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /guard: allowed/);
    assert.ok(s.calls.some((x) => x.cmd === 'npx' && x.args.includes('deploy')));
    assert.equal(c.s3.calls.length, 2);
  } finally {
    for (const k of Object.keys(env)) if (!(k in saved)) delete process.env[k];
  }
}));

test('shu-5ix: a failed release exits with the release script code', withTmp(async (tmp) => {
  const { dir } = consumer(tmp);
  const s = deploySpawn(CLEAN_DIFF, bundleDir(tmp));
  const c = releaseClients();
  const ssm = stubClient((x) => (x.constructor.name === 'SendCommandCommand'
    ? { Command: { CommandId: 'cmd-1' } }
    : { Status: 'Failed', ResponseCode: 12, StandardOutputContent: 'shukka: shukkatest/web a -> b rolled-back\n' }));
  const r = await cli(['deploy', '--skip-checks'], { cwd: dir, spawn: s.spawn, aws: fakeAws({ clients: () => ({ s3: c.s3.client, ssm: ssm.client, ec2: c.ec2.client }) }).aws });
  assert.equal(r.code, 12);
  assert.match(r.out, /rolled back; the previous release is live/);
}));

test('shu-5ix: diff prints the cdk diff and the guard verdict, and exits 1 when something would be replaced', withTmp(async (tmp) => {
  const { dir } = consumer(tmp);
  let s = deploySpawn(CLEAN_DIFF, '');
  let r = await cli(['diff', '--profile', 'stelking'], { cwd: dir, spawn: s.spawn });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /There were no differences[\s\S]*guard: nothing is deleted or replaced/);
  assert.ok(!s.calls.some((x) => x.args.includes('deploy') || x.args.includes('npm test')), 'diff deploys and checks nothing');

  s = deploySpawn(DESTRUCTIVE_DIFF, '');
  r = await cli(['diff'], { cwd: dir, spawn: s.spawn });
  assert.equal(r.code, 1);
  assert.match(r.out, /guard: these changes delete or replace a resource/);
}));

// ---------- --help ----------

test('shu-5ix: --help documents every command and every option', async () => {
  const text = helpText();
  for (const c of COMMANDS) {
    assert.match(text, new RegExp(`^${c.name}$`, 'm'), `section for ${c.name}`);
    for (const f of c.flags) assert.ok(text.includes(`--${f.name}`), `--${f.name} of ${c.name}`);
  }
  for (const phrase of ['bootstrap --account', 'bootstrap <project>', 'diff', 'deploy', 'origin/main', '--dry-run']) assert.ok(text.includes(phrase), phrase);

  for (const argv of [['--help'], ['help'], ['deploy', '--help'], ['bootstrap', '-h']]) {
    const r = await cli(argv);
    assert.equal(r.code, 0);
    assert.equal(r.out, text);
  }
  const unknown = await cli(['deploy', '--force']);
  assert.equal(unknown.code, 2);
  assert.match(unknown.err, /unknown option --force/);
  const nothing = await cli([]);
  assert.equal(nothing.code, 2);
});

test('shu-5ix: bin/shukka --help runs as the npx entry point', () => {
  const r = spawnSync(process.execPath, [join(root, 'bin', 'shukka'), '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, helpText());
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.bin.shukka, 'bin/shukka');
  assert.ok(pkg.dependencies.tsx, 'tsx is a runtime dependency: npx installs no devDependencies');
});
