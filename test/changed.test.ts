import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeChanges, globToRegExp, main, matchesAny, revisionScript } from '../scripts/changed.mjs';
import { validateConfig, type Config } from '../scripts/config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const exampleText = readFileSync(join(here, 'fixtures', 'config', 'trendigle.json'), 'utf8');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;

function configWith(change: (raw: Loose) => void = () => {}): Config {
  const raw = JSON.parse(exampleText);
  change(raw);
  const { config, problems } = validateConfig(raw);
  assert.ok(config, problems.join('\n'));
  return config;
}

// ---------------------------------------------------------------------------
// A fixture git history laid out like the design's Trendigle example.
//   c1  initial: infra, app, admin, docs
//   c2  app source changes
//   c3  docs only
//   c4  infra changes (through the second infra glob: tables.json under the app)
//   c5  admin changes
// ---------------------------------------------------------------------------
const repo = mkdtempSync(join(tmpdir(), 'shu-8f5-repo-'));
after(() => rmSync(repo, { recursive: true, force: true }));

function git(...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function commit(files: Record<string, string>, message: string): string {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', message);
  return git('rev-parse', 'HEAD');
}

git('init', '-q', '-b', 'main');
writeFileSync(join(repo, 'shukka.json'), exampleText);
const c1 = commit({
  'implementation/infra/bin/app.ts': 'v1',
  'implementation/app/src/page.ts': 'v1',
  'implementation/app/src/core/tables.json': '{}',
  'implementation/admin/src/page.ts': 'v1',
  'docs/README.md': 'v1',
  'README.md': 'v1',
}, 'c1');
const c2 = commit({ 'implementation/app/src/page.ts': 'v2' }, 'c2');
const c3 = commit({ 'docs/README.md': 'v2', 'README.md': 'v2' }, 'c3');
const c4 = commit({ 'implementation/app/src/core/tables.json': '{"t":1}' }, 'c4');
const c5 = commit({ 'implementation/admin/src/page.ts': 'v2' }, 'c5');

// ---------------------------------------------------------------------------
// Stubbed AWS clients. Each records the commands it was sent.
// ---------------------------------------------------------------------------
type Stack = { StackName: string; Tags?: { Key: string; Value: string }[] };
type Server = { id: string; revisions?: Record<string, string>; status?: string };

interface World {
  stacks?: Stack[] | Error;
  servers?: Server[] | Error;
  sendError?: Error;
  pendingPolls?: number;
}

function stack(name: string, revision?: string): Stack {
  return { StackName: name, Tags: revision === undefined ? [{ Key: 'Project', Value: 'trendigle' }] : [{ Key: 'Project', Value: 'trendigle' }, { Key: 'shukka:revision', Value: revision }] };
}

function stubs(world: World) {
  const sent: { client: string; command: string; input: Loose }[] = [];
  const record = (client: string, command: Loose) => sent.push({ client, command: command.constructor.name, input: command.input });
  let polls = 0;
  let lastScript = '';
  const cfn = {
    async send(command: Loose) {
      record('cfn', command);
      assert.equal(command.constructor.name, 'DescribeStacksCommand');
      if (world.stacks instanceof Error) throw world.stacks;
      const all = world.stacks ?? [];
      if (command.input.StackName) {
        const found = all.filter((s) => s.StackName === command.input.StackName);
        if (found.length === 0) throw Object.assign(new Error('Stack does not exist'), { name: 'ValidationError' });
        return { Stacks: found };
      }
      // Two pages, to exercise NextToken.
      const half = Math.ceil(all.length / 2);
      return command.input.NextToken ? { Stacks: all.slice(half) } : { Stacks: all.slice(0, half), NextToken: all.length > 1 ? 'page2' : undefined };
    },
  };
  const ec2 = {
    async send(command: Loose) {
      record('ec2', command);
      assert.equal(command.constructor.name, 'DescribeInstancesCommand');
      if (world.servers instanceof Error) throw world.servers;
      return { Reservations: [{ Instances: (world.servers ?? []).map((s) => ({ InstanceId: s.id })) }] };
    },
  };
  const ssm = {
    async send(command: Loose) {
      record('ssm', command);
      if (command.constructor.name === 'SendCommandCommand') {
        if (world.sendError) throw world.sendError;
        lastScript = command.input.Parameters.commands[0];
        return { Command: { CommandId: 'cmd-1' } };
      }
      assert.equal(command.constructor.name, 'GetCommandInvocationCommand');
      if (polls++ < (world.pendingPolls ?? 0)) {
        if (polls === 1) throw Object.assign(new Error('not yet'), { name: 'InvocationDoesNotExist' });
        return { Status: 'InProgress' };
      }
      const server = (world.servers as Server[]).find((s) => s.id === command.input.InstanceId);
      assert.ok(server);
      if (server.status && server.status !== 'Success') return { Status: server.status, StandardOutputContent: '' };
      // Answer the way the real script would: one line per app it asked for.
      const apps = [...lastScript.matchAll(/'%s\\t%s\\n' '([a-z0-9-]+)'/g)].map((m) => m[1] as string);
      const text = apps.map((app) => `${app}\t${server.revisions?.[app] ?? ''}`).join('\n') + '\n';
      return { Status: 'Success', StandardOutputContent: text };
    },
  };
  return { clients: { cfn, ec2, ssm }, sent };
}

const noWait = { sleep: async () => {}, timeoutMs: 10, intervalMs: 1 };

async function run(world: World, extra: { config?: Config; head?: string; force?: boolean; stacks?: string[] } = {}) {
  const { clients, sent } = stubs(world);
  const warnings: string[] = [];
  const changes = await computeChanges({
    config: extra.config ?? configWith(),
    repo,
    clients,
    wait: noWait,
    warn: (line: string) => warnings.push(line),
    ...(extra.head ? { head: extra.head } : {}),
    ...(extra.force ? { force: true } : {}),
    ...(extra.stacks ? { stacks: extra.stacks } : {}),
  });
  return { changes, sent, warnings };
}

// ---------------------------------------------------------------------------
// Criterion 1: JSON shape from the last deployed revisions.
// ---------------------------------------------------------------------------
test('shu-8f5: prints {infra, apps, base} from the stack tags and each app\'s current/REVISION', async () => {
  const world: World = {
    stacks: [stack('Trendigle-prod-Data', c3), stack('Trendigle-prod-Dns', c3), stack('Other-stack', c1)],
    servers: [{ id: 'i-1', revisions: { app: c1, admin: c5 } }],
  };
  const { clients, sent } = stubs(world);
  let printed = '';
  const errors: string[] = [];
  const code = await main([join(repo, 'shukka.json')], {
    clients, wait: noWait, out: (t) => { printed += t; }, err: (t) => { errors.push(t); },
  });
  assert.equal(code, 0, errors.join(''));
  assert.deepEqual(JSON.parse(printed), {
    infra: true, // tables.json changed in c4, after the stacks' c3
    apps: { app: true, admin: false }, // app changed in c2 and c4 since c1; admin deployed at head
    base: { infra: c3, apps: { app: c1, admin: c5 } },
  });
  // The REVISION is read through SSM Run Command on the project's tagged, running instances.
  const describe = sent.find((s) => s.command === 'DescribeInstancesCommand');
  assert.deepEqual(describe?.input.Filters, [
    { Name: 'tag:Project', Values: ['trendigle'] },
    { Name: 'instance-state-name', Values: ['running'] },
  ]);
  const send = sent.find((s) => s.command === 'SendCommandCommand');
  assert.equal(send?.input.DocumentName, 'AWS-RunShellScript');
  assert.deepEqual(send?.input.InstanceIds, ['i-1']);
  assert.match(send?.input.Parameters.commands[0], /cat '\/opt\/trendigle\/app\/current\/REVISION'/);
  assert.match(send?.input.Parameters.commands[0], /cat '\/opt\/trendigle\/admin\/current\/REVISION'/);
  // Stacks are read with DescribeStacks, following NextToken; other projects' stacks are ignored.
  assert.equal(sent.filter((s) => s.command === 'DescribeStacksCommand').length, 2);
});

test('shu-8f5: the server script names each app and reads only its current/REVISION', () => {
  assert.equal(
    revisionScript('trendigle', ['app', 'admin']),
    "printf '%s\\t%s\\n' 'app' \"$(cat '/opt/trendigle/app/current/REVISION' 2>/dev/null | head -n 1)\"\n" +
    "printf '%s\\t%s\\n' 'admin' \"$(cat '/opt/trendigle/admin/current/REVISION' 2>/dev/null | head -n 1)\"",
  );
});

test('shu-8f5: --head compares against the given commit, not HEAD', async () => {
  const { changes } = await run({
    stacks: [stack('Trendigle-prod-Data', c1)],
    servers: [{ id: 'i-1', revisions: { app: c1, admin: c1 } }],
  }, { head: c2 });
  assert.deepEqual(changes, { infra: false, apps: { app: true, admin: false }, base: { infra: c1, apps: { app: c1, admin: c1 } } });
});

test('shu-8f5: stacks deployed at different commits compare from the oldest', async () => {
  const { changes } = await run({
    stacks: [stack('Trendigle-prod-Data', c5), stack('Trendigle-prod-Dns', c3)],
    servers: [{ id: 'i-1', revisions: { app: c5, admin: c5 } }],
  });
  assert.equal(changes.infra, true);
  assert.equal(changes.base.infra, c3);
});

test('shu-8f5: servers on different releases of one app compare from the oldest', async () => {
  const { changes } = await run({
    stacks: [stack('Trendigle-prod-Data', c5)],
    servers: [{ id: 'i-1', revisions: { app: c5, admin: c5 } }, { id: 'i-2', revisions: { app: c1, admin: c5 } }],
  });
  assert.deepEqual(changes.apps, { app: true, admin: false });
  assert.equal(changes.base.apps.app, c1);
});

test('shu-8f5: --stacks names the stacks to read instead of listing by prefix', async () => {
  const { changes, sent } = await run({
    stacks: [stack('Trendigle-prod-Data', c5), stack('Trendigle-prod-Old', c1)],
    servers: [{ id: 'i-1', revisions: { app: c5, admin: c5 } }],
  }, { stacks: ['Trendigle-prod-Data'] });
  assert.equal(changes.infra, false);
  assert.equal(changes.base.infra, c5);
  assert.deepEqual(sent.filter((s) => s.client === 'cfn').map((s) => s.input), [{ StackName: 'Trendigle-prod-Data' }]);
});

test('shu-8f5: waits for the SSM invocation to finish', async () => {
  const { changes, sent } = await run({
    stacks: [stack('Trendigle-prod-Data', c5)],
    servers: [{ id: 'i-1', revisions: { app: c5, admin: c5 } }],
    pendingPolls: 3,
  });
  assert.deepEqual(changes.apps, { app: false, admin: false });
  assert.equal(sent.filter((s) => s.command === 'GetCommandInvocationCommand').length, 4);
});

test('shu-8f5: the SSM wait is one deadline across all instances', async () => {
  const { sent } = await run({
    stacks: [stack('Trendigle-prod-Data', c5)],
    servers: [{ id: 'i-1' }, { id: 'i-2' }, { id: 'i-3' }],
    pendingPolls: 1000,
  });
  // timeoutMs 10, interval 1: about 11 polls for the first instance, then one each for the rest.
  assert.ok(sent.filter((s) => s.command === 'GetCommandInvocationCommand').length <= 15);
});

// ---------------------------------------------------------------------------
// Criterion 2: globs; docs-only gives all false.
// ---------------------------------------------------------------------------
test('shu-8f5: config globs match paths: ** crosses directories, * and ? stay in one segment', () => {
  assert.ok(matchesAny('implementation/app/src/page.ts', ['implementation/app/**']));
  assert.ok(matchesAny('implementation/app/x', ['implementation/app/**']));
  assert.ok(!matchesAny('implementation/apple/x', ['implementation/app/**']));
  assert.ok(!matchesAny('implementation/admin/src/page.ts', ['implementation/app/**']));
  assert.ok(matchesAny('implementation/app/src/core/tables.json', ['implementation/infra/**', 'implementation/app/src/core/tables.json']));
  assert.ok(!matchesAny('implementation/app/src/core/tablesXjson', ['implementation/app/src/core/tables.json']));
  assert.ok(matchesAny('a/b.ts', ['a/*.ts']));
  assert.ok(!matchesAny('a/c/b.ts', ['a/*.ts']));
  assert.ok(matchesAny('a/c/d/b.ts', ['a/**/b.ts']));
  assert.ok(matchesAny('a/b.ts', ['a/**/b.ts']));
  assert.ok(matchesAny('ab', ['a?']));
  assert.ok(!matchesAny('a/', ['a?']));
  assert.ok(matchesAny('x.json', ['**/*.json']));
  assert.equal(globToRegExp('a(b)+c').test('a(b)+c'), true);
});

test('shu-8f5: {a,b} alternation matches each alternative and nothing else, nested too', () => {
  const glob = 'implementation/{app,shared}/**';
  assert.ok(matchesAny('implementation/app/x.ts', [glob]));
  assert.ok(matchesAny('implementation/shared/lib/y.ts', [glob]));
  assert.ok(!matchesAny('implementation/admin/x.ts', [glob]));
  assert.ok(!matchesAny('implementation/apps/x.ts', [glob]));
  assert.ok(matchesAny('src/x.test.ts', ['src/*.{ts,{mjs,cjs}}']));
  assert.ok(matchesAny('src/x.cjs', ['src/*.{ts,{mjs,cjs}}']));
  assert.ok(!matchesAny('src/x.js', ['src/*.{ts,{mjs,cjs}}']));
  assert.ok(matchesAny('a/x', ['{a,b/c}/*']) && matchesAny('b/c/x', ['{a,b/c}/*']) && !matchesAny('b/x', ['{a,b/c}/*']));
});

test('shu-8f5: [...] classes, ranges and [!...] negation match one character, never /', () => {
  assert.ok(matchesAny('src/a/x', ['src/[ab]/**']));
  assert.ok(matchesAny('src/b/x', ['src/[ab]/**']));
  assert.ok(!matchesAny('src/c/x', ['src/[ab]/**']));
  assert.ok(matchesAny('implementation/infra/bin/app.ts', ['implementation/[i]nfra/**']));
  assert.ok(matchesAny('src/q/x', ['src/[a-z]/**']));
  assert.ok(!matchesAny('src/Q/x', ['src/[a-z]/**']));
  assert.ok(!matchesAny('src/b/x', ['src/[!b]/**']));
  assert.ok(matchesAny('src/c/x', ['src/[!b]/**']));
  assert.ok(!matchesAny('src/b/x', ['src/[^b]/**']));
  assert.ok(!matchesAny('a/b', ['a[!x]b']));
  assert.ok(!matchesAny('a/b', ['a[/]b']));
  assert.ok(matchesAny('a-b', ['a[-x]b']) && matchesAny('a-b', ['a[x-]b']) && !matchesAny('a.b', ['a[x-]b']));
  assert.ok(matchesAny('a]b', ['a[]]b']));
  assert.ok(matchesAny('my-app/x', ['my-app/**']));
});

test('shu-8f5: a glob that cannot be parsed counts as matching, with a warning', () => {
  for (const glob of ['src/[ab/**', 'src/{a,b/**', 'src/[z-a]/**']) {
    const warnings: string[] = [];
    assert.ok(matchesAny('docs/README.md', [glob], (line) => warnings.push(line)), glob);
    assert.equal(warnings.length, 1, glob);
    assert.ok(warnings[0]?.includes(JSON.stringify(glob)), warnings[0]);
    assert.throws(() => globToRegExp(glob));
  }
});

test('shu-8f5: brace and class globs in the config drive the decision; an unparseable one deploys', async () => {
  const world = (): World => ({
    stacks: [stack('Trendigle-prod-Data', c4)],
    servers: [{ id: 'i-1', revisions: { app: c4, admin: c4 } }],
  });
  // c4..c5 changes only implementation/admin/src/page.ts.
  const braces = configWith((raw) => {
    raw.infra.paths = ['implementation/[i]nfra/**'];
    raw.apps[0].paths = ['implementation/{app,shared}/**'];
    raw.apps[1].paths = ['implementation/{adm[h-j]n,shared}/**'];
  });
  const { changes } = await run(world(), { config: braces, head: c5 });
  assert.deepEqual(changes, { infra: false, apps: { app: false, admin: true }, base: { infra: c4, apps: { app: c4, admin: c4 } } });

  const broken = configWith((raw) => { raw.infra.paths = ['implementation/[infra/**']; });
  const out = await run(world(), { config: broken, head: c5 });
  assert.equal(out.changes.infra, true);
  assert.ok(out.warnings.some((w) => w.startsWith('infra: ') && w.includes('unclosed [')), out.warnings.join('\n'));
});

test('shu-8f5: a docs-only change since every deployed revision gives all false', async () => {
  const { changes } = await run({
    stacks: [stack('Trendigle-prod-Data', c2), stack('Trendigle-prod-Dns', c2)],
    servers: [{ id: 'i-1', revisions: { app: c2, admin: c2 } }],
  }, { head: c3 });
  assert.deepEqual(changes, { infra: false, apps: { app: false, admin: false }, base: { infra: c2, apps: { app: c2, admin: c2 } } });
});

test('shu-8f5: a change only under one app\'s globs marks only that app', async () => {
  const { changes } = await run({
    stacks: [stack('Trendigle-prod-Data', c4)],
    servers: [{ id: 'i-1', revisions: { app: c4, admin: c4 } }],
  }, { head: c5 });
  assert.deepEqual(changes, { infra: false, apps: { app: false, admin: true }, base: { infra: c4, apps: { app: c4, admin: c4 } } });
});

// ---------------------------------------------------------------------------
// Criterion 3: unknown last revision means true for that part.
// ---------------------------------------------------------------------------
const deployedAtHead = (): World => ({
  stacks: [stack('Trendigle-prod-Data', c5), stack('Trendigle-prod-Dns', c5)],
  servers: [{ id: 'i-1', revisions: { app: c5, admin: c5 } }],
});

test('shu-8f5: everything deployed at head gives all false (control for the unknown cases)', async () => {
  const { changes } = await run(deployedAtHead());
  assert.deepEqual(changes, { infra: false, apps: { app: false, admin: false }, base: { infra: c5, apps: { app: c5, admin: c5 } } });
});

test('shu-8f5: first deploy (no stacks, no servers) gives all true with null bases', async () => {
  const { changes, warnings } = await run({ stacks: [], servers: [] });
  assert.deepEqual(changes, { infra: true, apps: { app: true, admin: true }, base: { infra: null, apps: { app: null, admin: null } } });
  assert.ok(warnings.length > 0);
});

test('shu-8f5: a project stack without the shukka:revision tag makes infra true', async () => {
  const world = deployedAtHead();
  world.stacks = [stack('Trendigle-prod-Data', c5), stack('trendigle-prod-Mail')];
  const { changes } = await run(world);
  assert.equal(changes.infra, true);
  assert.equal(changes.base.infra, null);
  assert.deepEqual(changes.apps, { app: false, admin: false });
});

test('shu-8f5: a named stack that does not exist makes infra true', async () => {
  const { changes } = await run(deployedAtHead(), { stacks: ['Trendigle-prod-Data', 'Trendigle-prod-Gone'] });
  assert.equal(changes.infra, true);
  assert.equal(changes.base.infra, null);
});

test('shu-8f5: stacks that cannot be read make infra true', async () => {
  const world = deployedAtHead();
  world.stacks = Object.assign(new Error('AccessDenied'), { name: 'AccessDenied' });
  const { changes } = await run(world);
  assert.equal(changes.infra, true);
  assert.equal(changes.base.infra, null);
  assert.deepEqual(changes.apps, { app: false, admin: false });
});

test('shu-8f5: a tag naming a commit not in the checkout (or not a sha) makes infra true', async () => {
  for (const bad of ['0123456789abcdef0123456789abcdef01234567', '--upload-pack=evil', 'main']) {
    const world = deployedAtHead();
    world.stacks = [stack('Trendigle-prod-Data', bad)];
    const { changes } = await run(world);
    assert.equal(changes.infra, true, bad);
    assert.equal(changes.base.infra, null, bad);
  }
});

test('shu-8f5: an app without current/REVISION on the server is true; the others are read', async () => {
  const world = deployedAtHead();
  world.servers = [{ id: 'i-1', revisions: { admin: c5 } }];
  const { changes } = await run(world);
  assert.deepEqual(changes.apps, { app: true, admin: false });
  assert.deepEqual(changes.base.apps, { app: null, admin: c5 });
});

test('shu-8f5: no running instance makes every app true', async () => {
  const world = deployedAtHead();
  world.servers = [];
  const { changes, sent } = await run(world);
  assert.deepEqual(changes.apps, { app: true, admin: true });
  assert.equal(changes.infra, false);
  assert.ok(!sent.some((s) => s.command === 'SendCommandCommand'));
});

test('shu-8f5: an unreachable server (failed invocation, send refused, listing refused, timeout) makes every app true', async () => {
  const cases: [string, (w: World) => void][] = [
    ['invocation failed', (w) => { w.servers = [{ id: 'i-1', status: 'Failed' }]; }],
    ['undeliverable', (w) => { w.servers = [{ id: 'i-1', status: 'Undeliverable' }]; }],
    ['send refused', (w) => { w.sendError = Object.assign(new Error('InvalidInstanceId'), { name: 'InvalidInstanceId' }); }],
    ['listing refused', (w) => { w.servers = Object.assign(new Error('UnauthorizedOperation'), { name: 'UnauthorizedOperation' }); }],
    ['timeout', (w) => { w.pendingPolls = 1000; }],
    ['one of two servers down', (w) => { w.servers = [{ id: 'i-1', revisions: { app: c5, admin: c5 } }, { id: 'i-2', status: 'TimedOut' }]; }],
  ];
  for (const [name, change] of cases) {
    const world = deployedAtHead();
    change(world);
    const { changes } = await run(world);
    assert.deepEqual(changes.apps, { app: true, admin: true }, name);
    assert.deepEqual(changes.base.apps, { app: null, admin: null }, name);
    assert.equal(changes.infra, false, name);
  }
});

// ---------------------------------------------------------------------------
// Criterion 4: alwaysDeploy or --force gives all true.
// ---------------------------------------------------------------------------
test('shu-8f5: alwaysDeploy gives all true without reading AWS', async () => {
  const { changes, sent } = await run(deployedAtHead(), { config: configWith((raw) => { raw.alwaysDeploy = true; }) });
  assert.deepEqual(changes, { infra: true, apps: { app: true, admin: true }, base: { infra: null, apps: { app: null, admin: null } } });
  assert.deepEqual(sent, []);
});

test('shu-8f5: --force gives all true without reading AWS', async () => {
  const { clients, sent } = stubs(deployedAtHead());
  let printed = '';
  const code = await main([join(repo, 'shukka.json'), '--force'], { clients, wait: noWait, out: (t) => { printed += t; }, err: () => {} });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(printed), { infra: true, apps: { app: true, admin: true }, base: { infra: null, apps: { app: null, admin: null } } });
  assert.deepEqual(sent, []);
});

test('shu-8f5: usage errors and an invalid config exit non-zero', async () => {
  const quiet = { out: () => {}, err: () => {} };
  assert.equal(await main([], quiet), 2);
  assert.equal(await main([join(repo, 'shukka.json'), '--head'], quiet), 2);
  assert.equal(await main([join(repo, 'shukka.json'), '--head', '--upload-pack=x'], quiet), 2);
  const bad = join(repo, 'bad.json');
  writeFileSync(bad, '{"project": "x"}');
  try {
    assert.equal(await main([bad], quiet), 1);
  } finally {
    rmSync(bad);
  }
});
