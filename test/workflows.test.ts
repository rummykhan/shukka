// shu-9zr: the reusable workflows. Two kinds of test:
//   - static: parse the YAML and check what the design and the project rules require of it
//     (permissions, id-token only in infra.yml and ec2.yml, no expressions in run:, pinned actions,
//     concurrency, full history where changed.mjs runs, the artifact outside both checkouts);
//   - dry composition: run the steps' own bash, in a fake workspace, with shukka's real scripts and
//     stubbed AWS clients (and a fake `npx cdk`), to show each step calls the scripts with arguments
//     they accept and turns their results into the outputs, log lines and summary the design names.
// Real GitHub runs are proven only by the acceptance suite against the test consumer.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const workflowsDir = join(root, '.github', 'workflows');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;

function workflow(name: string): Loose {
  return parse(readFileSync(join(workflowsDir, name), 'utf8')) as Loose;
}
const pipeline = workflow('pipeline.yml');
const infra = workflow('infra.yml');
const ec2 = workflow('ec2.yml');
const allWorkflows = readdirSync(workflowsDir).filter((f) => /\.ya?ml$/.test(f)).map((f) => ({ file: f, doc: workflow(f) }));

function jobs(doc: Loose): [string, Loose][] {
  return Object.entries(doc.jobs as Record<string, Loose>);
}
function steps(job: Loose): Loose[] {
  return (job.steps ?? []) as Loose[];
}
function step(doc: Loose, jobId: string, name: string): Loose {
  const found = steps(doc.jobs[jobId]).find((s) => s.name === name);
  assert.ok(found, `no step "${name}" in job ${jobId}`);
  return found;
}

// ---------------------------------------------------------------------------
// Static: what the workflows declare.
// ---------------------------------------------------------------------------
test('shu-9zr: actionlint passes on every workflow', () => {
  const r = spawnSync('actionlint', [], { cwd: root, encoding: 'utf8' });
  assert.ok(!r.error, `actionlint must be on PATH: ${r.error?.message}`);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('shu-9zr: pipeline.yml has the design\'s jobs, each with its own permissions; plan, checks, build and smoke get contents: read only', () => {
  assert.deepEqual(Object.keys(pipeline.jobs), ['plan', 'checks', 'build', 'diff', 'infra', 'app', 'smoke']);
  assert.deepEqual(pipeline.permissions, {}, 'nothing granted at workflow level');
  for (const id of ['plan', 'checks', 'build', 'smoke']) {
    assert.deepEqual(pipeline.jobs[id].permissions, { contents: 'read' }, id);
  }
  assert.equal(pipeline.jobs.infra.uses, './.github/workflows/infra.yml');
  assert.equal(pipeline.jobs.infra.with.mode, 'deploy');
  assert.equal(pipeline.jobs.diff.uses, './.github/workflows/infra.yml');
  assert.equal(pipeline.jobs.diff.with.mode, 'diff');
  assert.equal(pipeline.jobs.app.uses, './.github/workflows/ec2.yml');
  // The order of the chain: plan → checks + build → infra → app → smoke; diff on pull requests.
  assert.deepEqual(pipeline.jobs.infra.needs, ['plan', 'checks', 'build']);
  assert.deepEqual(pipeline.jobs.app.needs, ['plan', 'infra']);
  assert.deepEqual(pipeline.jobs.smoke.needs, ['plan', 'infra', 'app']);
  assert.match(pipeline.jobs.diff.if, /github\.event_name == 'pull_request'/);
  for (const id of ['build', 'infra']) assert.match(pipeline.jobs[id].if, /github\.event_name != 'pull_request'/, id);
  // The inputs the caller contract passes, plus the documented optional ones.
  assert.deepEqual(Object.keys(pipeline.on.workflow_call.inputs), ['config', 'allow_replacement', 'force', 'deploy_bucket', 'shukka_ref']);
  assert.equal(pipeline.jobs.infra.with.allow_replacement, '${{ inputs.allow_replacement }}');
  assert.equal(pipeline.jobs.infra.with.force, '${{ inputs.force }}');
  assert.equal(pipeline.jobs.app.with.force, '${{ inputs.force }}');
});

test('shu-9zr: job display names carry the words the acceptance suite matches', () => {
  assert.equal(pipeline.jobs.plan.name, 'plan');
  assert.match(pipeline.jobs.checks.name, /^check /);
  assert.match(pipeline.jobs.build.name, /^build /);
  assert.equal(pipeline.jobs.smoke.name, 'smoke');
  assert.deepEqual(jobs(infra).map(([id, j]) => [id, j.name]), [['changes', 'changes'], ['deploy', 'deploy'], ['diff', 'diff']]);
  assert.deepEqual(jobs(ec2).map(([id, j]) => [id, j.name]), [['changes', 'changes'], ['release', 'release ${{ matrix.app }}']]);
  // The suite (test/acceptance/lib/common.sh) matches, case-insensitively: plan, check, build,
  // infra|deploy (minus diff and app matches), diff, app|ec2|release, smoke. Every name a run can
  // show, with which pattern it must (and must not) match.
  const shown = (caller: string, inner: string[]) => [caller, ...inner.map((j) => `${caller} / ${j}`)];
  const names: Record<string, string[]> = {
    plan: [`shukka / ${pipeline.jobs.plan.name}`],
    check: [`shukka / ${pipeline.jobs.checks.name.replace('${{ matrix.check.name }}', 'lint')}`],
    build: [`shukka / ${pipeline.jobs.build.name.replace('${{ matrix.app.name }}', 'web')}`],
    // The other mode's job is listed as skipped: on a merge "stacks / diff", on a pull request
    // "pull request / deploy". A skipped job does not spoil "did not run", and each matches only its own word.
    diff: [`shukka / ${pipeline.jobs.diff.name} / diff`, `shukka / ${pipeline.jobs.infra.name} / diff`],
    deploy: [`shukka / ${pipeline.jobs.infra.name} / deploy`, `shukka / ${pipeline.jobs.diff.name} / deploy`],
    release: [`shukka / ${pipeline.jobs.app.name} / release web`, `shukka / ${pipeline.jobs.app.name} / release \${{ matrix.app }}`],
    smoke: [`shukka / ${pipeline.jobs.smoke.name}`],
    none: [
      ...shown(`shukka / ${pipeline.jobs.diff.name}`, ['changes']),
      ...shown(`shukka / ${pipeline.jobs.infra.name}`, ['changes']),
      ...shown(`shukka / ${pipeline.jobs.app.name}`, ['changes']),
    ],
  };
  const patterns: Record<string, RegExp> = { plan: /plan/i, check: /check/i, build: /build/i, diff: /diff/i, deploy: /infra|deploy/i, release: /app|ec2|release/i, smoke: /smoke/i };
  for (const [kind, list] of Object.entries(names)) {
    for (const name of list) {
      for (const [other, re] of Object.entries(patterns)) assert.equal(re.test(name), kind === other, `${name} vs ${other}`);
    }
  }
});

test('shu-9zr: no job outside infra.yml and ec2.yml has id-token; pipeline.yml only passes it to them', () => {
  for (const { file, doc } of allWorkflows) {
    const top = doc.permissions;
    assert.ok(top === undefined || typeof top !== 'object' || top['id-token'] === undefined, `${file}: id-token at workflow level`);
    assert.notEqual(top, 'write-all', `${file}: write-all`);
    for (const [id, job] of jobs(doc)) {
      const perms = job.permissions;
      assert.notEqual(perms, 'write-all', `${file} ${id}: write-all`);
      const idToken = perms && typeof perms === 'object' ? perms['id-token'] : undefined;
      if (idToken === undefined || idToken === 'none') continue;
      if (file === 'infra.yml' || file === 'ec2.yml') continue;
      // A caller job hands id-token only to the two nested workflows; it runs no steps itself.
      assert.equal(file, 'pipeline.yml', `${file} ${id} has id-token`);
      assert.ok(['./.github/workflows/infra.yml', './.github/workflows/ec2.yml'].includes(job.uses), `pipeline.yml ${id} has id-token but runs steps`);
      assert.equal(job.steps, undefined);
    }
  }
  // Inside the nested workflows every job states its permissions.
  for (const doc of [infra, ec2]) {
    assert.deepEqual(doc.permissions, {});
    for (const [id, job] of jobs(doc)) assert.equal(typeof job.permissions, 'object', id);
  }
});

test('shu-9zr: no ${{ }} expression appears in any run: script (inputs, events and matrix go through env:)', () => {
  let scripts = 0;
  for (const { file, doc } of allWorkflows) {
    for (const [id, job] of jobs(doc)) {
      for (const s of steps(job)) {
        if (typeof s.run !== 'string') continue;
        scripts++;
        assert.doesNotMatch(s.run, /\$\{\{/, `${file} ${id} "${s.name ?? s.run.slice(0, 40)}"`);
      }
    }
  }
  assert.ok(scripts > 20, 'the scan saw the scripts');
});

test('shu-9zr: every third-party action is pinned by a full commit sha', () => {
  let actions = 0;
  for (const { file, doc } of allWorkflows) {
    for (const [id, job] of jobs(doc)) {
      for (const s of steps(job)) {
        if (s.uses === undefined) continue;
        actions++;
        assert.match(s.uses, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40}$/, `${file} ${id}: ${s.uses}`);
      }
    }
  }
  assert.ok(actions > 20);
});

test('shu-9zr: every checkout is without persisted credentials and never of a pull request head', () => {
  for (const { file, doc } of allWorkflows) {
    for (const [id, job] of jobs(doc)) {
      for (const s of steps(job).filter((x) => String(x.uses ?? '').startsWith('actions/checkout@'))) {
        assert.equal(s.with?.['persist-credentials'], false, `${file} ${id}`);
        assert.doesNotMatch(JSON.stringify(s.with ?? {}), /pull_request\.head|head_ref|head\.sha/, `${file} ${id}`);
      }
    }
  }
});

test('shu-9zr: infra.yml and ec2.yml are only callable, refuse the events that run untrusted code with secrets, and set no environment', () => {
  for (const doc of [infra, ec2]) {
    assert.deepEqual(Object.keys(doc.on), ['workflow_call']);
    for (const [id, job] of jobs(doc)) {
      assert.equal(job.environment, undefined, id);
      const credentialed = job.permissions?.['id-token'] === 'write';
      assert.ok(credentialed, `${id} is a credentialed job`);
      // Either the job refuses the three events itself or it needs a job that does.
      const guarded = (j: Loose): boolean => /pull_request_target.*issue_comment.*workflow_run/.test(String(j.if ?? ''))
        || [j.needs ?? []].flat().some((n: string) => guarded(doc.jobs[n]));
      assert.ok(guarded(job), `${id} does not refuse pull_request_target, issue_comment and workflow_run`);
    }
  }
});

test('shu-9zr: ec2.yml checks out without installing anything, downloads the artifact, uploads, releases, one release per app at a time', () => {
  const release = ec2.jobs.release;
  assert.deepEqual(release.concurrency, { group: 'shukka-${{ needs.changes.outputs.project }}-${{ matrix.app }}', 'cancel-in-progress': false });
  assert.equal(release.strategy.matrix.app, '${{ fromJSON(needs.changes.outputs.apps) }}');
  const names = steps(release).map((s) => s.name ?? s.uses);
  const order = ['Check out the project', 'Download the bundle', 'Unpack the bundle', 'Assume the app role', 'Upload the bundle', 'Release'];
  const at = order.map((n) => names.indexOf(n));
  assert.ok(at.every((i) => i >= 0), JSON.stringify(names));
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'in this order');
  for (const [id, job] of jobs(ec2)) {
    for (const s of steps(job)) {
      assert.doesNotMatch(String(s.run ?? ''), /\b(npm|npx|yarn|pnpm|pip3?|bun)\b/, `${id}: ${s.name}`);
      assert.equal(s.with?.cache, undefined, `${id}: ${s.name} restores no cache`);
    }
  }
  assert.match(step(ec2, 'release', 'Upload the bundle').run, /\.shukka\/scripts\/upload\.mjs/);
  assert.match(step(ec2, 'release', 'Release').run, /\.shukka\/scripts\/release\.mjs .*--checkout project/s);
});

test('shu-9zr: the artifact is downloaded and unpacked outside both checkouts', () => {
  const checkoutPaths = steps(ec2.jobs.release).filter((s) => String(s.uses ?? '').startsWith('actions/checkout@')).map((s) => s.with.path);
  assert.deepEqual(checkoutPaths, ['project', '.shukka']);
  const download = step(ec2, 'release', 'Download the bundle');
  assert.match(download.uses, /^actions\/download-artifact@/);
  assert.match(download.with.path, /^\$\{\{ runner\.temp \}\}\//);
  const unpack = step(ec2, 'release', 'Unpack the bundle').run;
  assert.match(unpack, /dest="\$RUNNER_TEMP\//);
  assert.match(step(ec2, 'release', 'Upload the bundle').run, /--dir "\$RUNNER_TEMP\//);
});

test('shu-9zr: every job that runs changed.mjs checks out the project with full history', () => {
  let found = 0;
  for (const { file, doc } of allWorkflows) {
    for (const [id, job] of jobs(doc)) {
      if (!steps(job).some((s) => /changed\.mjs/.test(String(s.run ?? '')))) continue;
      found++;
      const project = steps(job).find((s) => String(s.uses ?? '').startsWith('actions/checkout@') && s.with?.path === 'project');
      assert.equal(project?.with?.['fetch-depth'], 0, `${file} ${id}`);
    }
  }
  assert.equal(found, 2, 'infra.yml changes and ec2.yml changes');
});

test('shu-9zr: credentialed jobs take shukka\'s scripts from the commit in their OIDC token', () => {
  for (const [file, doc] of [['infra.yml', infra], ['ec2.yml', ec2]] as const) {
    for (const [id, job] of jobs(doc)) {
      const find = steps(job).find((s) => s.name === 'Find the shukka commit this job runs');
      assert.ok(find, `${file} ${id}`);
      assert.equal(find.env.WORKFLOW_FILE, file);
      const co = steps(job).find((s) => s.with?.path === '.shukka');
      assert.equal(co?.with?.ref, '${{ steps.shukka.outputs.sha }}', `${file} ${id}`);
      assert.equal(co?.with?.repository, '${{ steps.shukka.outputs.repository }}', `${file} ${id}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Dry composition: run the steps' bash against a fake workspace.
// ---------------------------------------------------------------------------
const scratch = mkdtempSync(join(tmpdir(), 'shu-9zr-workflows-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const fakeBin = join(scratch, 'bin');
mkdirSync(fakeBin);
// `npx --no-install cdk <command>`: diff prints $FAKE_DIFF (and --method in its help when
// FAKE_CDK_METHOD=1); every call is logged one per line to $FAKE_NPX_LOG.
writeFileSync(join(fakeBin, 'npx'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >>"$FAKE_NPX_LOG"
[[ "$1" == --no-install && "$2" == cdk ]] || { echo "fake npx: unexpected $*" >&2; exit 97; }
case "$3" in
  diff)
    if [[ " $* " == *" --help "* ]]; then
      [[ "\${FAKE_CDK_METHOD:-0}" == 1 ]] && echo '  --method, -m   How to compute the diff'
      exit 0
    fi
    cat "$FAKE_DIFF"; exit "\${FAKE_DIFF_STATUS:-0}";;
  deploy) echo "fake cdk: deployed"; exit "\${FAKE_DEPLOY_STATUS:-0}";;
  *) echo "fake npx: unexpected $*" >&2; exit 97;;
esac
`);
chmodSync(join(fakeBin, 'npx'), 0o755);

// SHUKKA_NODE: real node, except that changed.mjs, upload.mjs and release.mjs run their own main()
// with stubbed AWS clients (from $FAKE_WORLD), and each call's arguments are logged to $FAKE_LOG.
const fakeNodeModule = join(scratch, 'fake-node.mjs');
writeFileSync(fakeNodeModule, `
import { appendFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
const name = basename(args[0] ?? '');
const world = JSON.parse(process.env.FAKE_WORLD || '{}');
const sent = [];
const record = (client, command) => { sent.push({ client, command: command.constructor.name, input: command.input }); };
const fail = () => { if (world.awsError) throw Object.assign(new Error(world.awsError), { name: 'AccessDenied' }); };
const stubs = {
  cfn: { async send(c) { record('cfn', c); fail(); return { Stacks: (world.stacks ?? []).filter((s) => !c.input.StackName || s.StackName === c.input.StackName) }; } },
  ec2: { async send(c) { record('ec2', c); fail(); return { Reservations: [{ Instances: [{ InstanceId: 'i-0123456789abcdef0' }] }] }; } },
  s3: { async send(c) { record('s3', c); fail(); return {}; } },
  ssm: { async send(c) {
    record('ssm', c); fail();
    if (c.constructor.name === 'SendCommandCommand') return { Command: { CommandId: 'cmd-1' } };
    if (name === 'changed.mjs') {
      const apps = Object.keys(world.revisions ?? {});
      return { Status: 'Success', StandardOutputContent: apps.map((a) => a + '\\t' + world.revisions[a]).join('\\n') + '\\n' };
    }
    return { Status: 'Success', ResponseCode: 0, StandardOutputContent: 'shukka: p/a old -> new live\\n' };
  } },
};
if (['changed.mjs', 'upload.mjs', 'release.mjs'].includes(name)) {
  const mod = await import(pathToFileURL(resolve(args[0])).href);
  const deps = name === 'changed.mjs'
    ? { clients: { cfn: stubs.cfn, ec2: stubs.ec2, ssm: stubs.ssm }, wait: { sleep: async () => {}, timeoutMs: 10, intervalMs: 1 } }
    : { s3: stubs.s3, ssm: stubs.ssm, ec2: stubs.ec2, pollMs: 1 };
  const code = await mod.main(args.slice(1), deps);
  appendFileSync(process.env.FAKE_LOG, JSON.stringify({ script: name, args: args.slice(1), code, sent }) + '\\n');
  process.exitCode = code;
} else {
  const r = spawnSync(process.execPath, args, { stdio: 'inherit' });
  process.exitCode = r.status ?? 1;
}
`);
const fakeNode = join(fakeBin, 'shukka-node');
writeFileSync(fakeNode, `#!/usr/bin/env bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeNodeModule)} "$@"\n`);
chmodSync(fakeNode, 0o755);

const SHUKKA_REPO_SHA = 'a'.repeat(40);

const fixtureConfig = {
  project: 'shukkatest',
  qualifier: 'shukkatest',
  aws: { account: '123456789012', region: 'us-east-1' },
  node: '22',
  checks: [{ name: 'lint', dir: '.', run: ['echo checked >check-ran.txt', 'test -f check-ran.txt'] }],
  infra: { dir: 'infra', paths: ['infra/**'] },
  apps: [
    {
      name: 'web',
      paths: ['apps/web/**'],
      build: { dir: 'apps/web', run: ['bash build.sh'], bundle: 'bundle.sh', env: { GREETING_STYLE: 'plain' }, buildEnv: ['SHUKKATEST_GREETING'] },
      server: { configure: 'box/configure.sh', units: ['shukkatest-web'], health: 'http://127.0.0.1:8080/health' },
    },
    {
      name: 'api',
      paths: ['apps/api/**'],
      build: { dir: 'apps/api', run: ['true'], bundle: 'bundle.sh' },
      server: { configure: 'box/configure.sh', units: ['shukkatest-api'], health: 'http://127.0.0.1:8081/health' },
    },
  ],
  smoke: { run: 'bash smoke.sh' },
  alwaysDeploy: false,
};

interface Workspace { dir: string; project: string; shukka: string; temp: string; commits: Record<string, string> }

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

/** A fresh GITHUB_WORKSPACE with ./project (a git repo) and ./.shukka (this checkout's scripts). */
function workspace(): Workspace {
  const dir = mkdtempSync(join(scratch, 'ws-'));
  const project = join(dir, 'project');
  const temp = join(dir, 'runner-temp');
  mkdirSync(temp);
  const files: Record<string, string> = {
    'shukka.json': JSON.stringify(fixtureConfig, null, 2),
    '.github/workflows/ci.yml': 'jobs:\n  shukka:\n    uses: rummykhan/shukka/.github/workflows/pipeline.yml@v1.0.0-rc.3\n',
    'infra/bin/app.mjs': 'v1',
    'apps/web/build.sh': 'set -euo pipefail\nrm -rf dist && mkdir dist\nprintf "%s %s\\n" "$SHUKKATEST_GREETING" "$GREETING_STYLE" >dist/greeting.txt\necho "build output goes to the log"\n',
    'apps/web/bundle.sh': 'set -euo pipefail\necho "bundle: noise on stdout before the path"\nprintf "%s\\n" dist\n',
    'apps/api/bundle.sh': 'printf "%s\\n" "$PWD"\n',
    'box/configure.sh': '#!/bin/sh\necho configure from git\n',
    'smoke.sh': 'echo "smoke: checking the site"\nexit "${SMOKE_EXIT:-0}"\n',
    'README.md': 'v1',
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(project, path)), { recursive: true });
    writeFileSync(join(project, path), text);
  }
  sh(dir, 'init', '-q', '-b', 'main', project);
  const commit = (message: string) => {
    sh(project, 'add', '-A');
    sh(project, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', message);
    return sh(project, 'rev-parse', 'HEAD');
  };
  const c1 = commit('c1');
  writeFileSync(join(project, 'README.md'), 'v2');
  const c2 = commit('docs only');
  writeFileSync(join(project, 'apps/web/build.sh'), files['apps/web/build.sh'] + '# v2\n');
  const c3 = commit('web changes');

  // .shukka: shukka's scripts and schema copied (release.mjs finds box/ next to its own file), with
  // a stand-in box/shukka-release.sh and this checkout's node_modules.
  const shukka = join(dir, '.shukka');
  mkdirSync(join(shukka, 'box'), { recursive: true });
  cpSync(join(root, 'scripts'), join(shukka, 'scripts'), { recursive: true });
  cpSync(join(root, 'schema'), join(shukka, 'schema'), { recursive: true });
  cpSync(join(root, 'package.json'), join(shukka, 'package.json'));
  symlinkSync(join(root, 'node_modules'), join(shukka, 'node_modules'));
  writeFileSync(join(shukka, 'box', 'shukka-release.sh'), '#!/bin/bash\necho stand-in release script\n');
  return { dir, project, shukka, temp, commits: { c1, c2, c3 } };
}

interface StepResult { code: number; out: string; outputs: Record<string, string>; summary: string; npx: string[]; calls: Loose[] }

/**
 * Run one step's `run:` script the way GitHub does (bash --noprofile --norc -eo pipefail), with
 * its env: values; every ${{ }} in them must be given in `exprs`.
 */
async function runStep(ws: Workspace, doc: Loose, jobId: string, name: string, exprs: Record<string, string>, extraEnv: Record<string, string> = {}): Promise<StepResult> {
  const s = step(doc, jobId, name);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries((s.env ?? {}) as Record<string, string>)) {
    env[key] = String(value).replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, expr: string) => {
      assert.ok(expr in exprs, `${jobId} "${name}": give a value for \${{ ${expr} }}`);
      return exprs[expr] as string;
    });
  }
  const files = { output: join(ws.temp, 'output'), summary: join(ws.temp, 'summary'), env: join(ws.temp, 'env'), log: join(ws.temp, 'calls.jsonl'), npx: join(ws.temp, 'npx.log') };
  for (const f of Object.values(files)) writeFileSync(f, '');
  const script = join(ws.temp, 'step.sh');
  writeFileSync(script, s.run);
  const cwd = s['working-directory'] ? join(ws.dir, s['working-directory']) : ws.dir;
  const child = spawn('bash', ['--noprofile', '--norc', '-eo', 'pipefail', script], {
    cwd,
    env: {
      PATH: `${fakeBin}:${dirname(process.execPath)}:${process.env.PATH}`,
      HOME: process.env.HOME ?? ws.dir,
      GITHUB_WORKSPACE: ws.dir,
      GITHUB_OUTPUT: files.output,
      GITHUB_STEP_SUMMARY: files.summary,
      GITHUB_ENV: files.env,
      RUNNER_TEMP: ws.temp,
      SHUKKA_NODE: fakeNode,
      FAKE_LOG: files.log,
      FAKE_NPX_LOG: files.npx,
      AWS_EC2_METADATA_DISABLED: 'true',
      ...env,
      ...extraEnv,
    },
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const code = await new Promise<number>((resolve) => child.on('close', (c) => resolve(c ?? -1)));
  const outputs = Object.fromEntries(readFileSync(files.output, 'utf8').split('\n').filter(Boolean).map((line) => {
    const i = line.indexOf('=');
    return [line.slice(0, i), line.slice(i + 1)];
  }));
  return {
    code,
    out,
    outputs,
    summary: readFileSync(files.summary, 'utf8'),
    npx: readFileSync(files.npx, 'utf8').split('\n').filter(Boolean),
    calls: readFileSync(files.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)),
  };
}

const lines = (text: string) => text.split('\n');

test('shu-9zr: plan finds the shukka version in the caller file, or takes shukka_ref, and refuses to guess', async () => {
  const ws = workspace();
  const exprs = { 'github.workflow_ref': 'acme/site/.github/workflows/ci.yml@refs/heads/main', 'inputs.shukka_ref': '' };
  const found = await runStep(ws, pipeline, 'plan', 'Find the shukka version this run uses', exprs);
  assert.equal(found.code, 0, found.out);
  assert.deepEqual(found.outputs, { repository: 'rummykhan/shukka', ref: 'v1.0.0-rc.3' });

  const given = await runStep(ws, pipeline, 'plan', 'Find the shukka version this run uses', { ...exprs, 'inputs.shukka_ref': 'v1.2.3' });
  assert.deepEqual(given.outputs, { repository: 'rummykhan/shukka', ref: 'v1.2.3' });

  writeFileSync(join(ws.project, '.github/workflows/ci.yml'), 'jobs:\n  a:\n    uses: rummykhan/shukka/.github/workflows/pipeline.yml@v1\n  b:\n    uses: rummykhan/shukka/.github/workflows/pipeline.yml@v2\n');
  const two = await runStep(ws, pipeline, 'plan', 'Find the shukka version this run uses', exprs);
  assert.equal(two.code, 1);
  assert.match(two.out, /expected one pipeline\.yml reference .* found 2; pass shukka_ref/);

  const bad = await runStep(ws, pipeline, 'plan', 'Find the shukka version this run uses', { ...exprs, 'inputs.shukka_ref': '--upload-pack=x' });
  assert.equal(bad.code, 1);
});

test('shu-9zr: plan validates shukka.json with config.mjs and hands the jobs its checks, apps and smoke', async () => {
  const ws = workspace();
  const r = await runStep(ws, pipeline, 'plan', 'Read shukka.json', { 'inputs.config': 'shukka.json' });
  assert.equal(r.code, 0, r.out);
  const config = JSON.parse(r.outputs.config as string);
  assert.equal(config.project, 'shukkatest');
  assert.deepEqual(config.apps.map((a: Loose) => a.name), ['web', 'api']);
  assert.deepEqual({ ...r.outputs, config: undefined }, { config: undefined, node: '22', has_checks: 'true', has_apps: 'true', has_smoke: 'true' });

  writeFileSync(join(ws.project, 'shukka.json'), JSON.stringify({ ...fixtureConfig, project: 'Bad Name' }));
  const invalid = await runStep(ws, pipeline, 'plan', 'Read shukka.json', { 'inputs.config': 'shukka.json' });
  assert.equal(invalid.code, 1);
  assert.match(invalid.out, /^shukka\.json: /m);
  const escape = await runStep(ws, pipeline, 'plan', 'Read shukka.json', { 'inputs.config': '../shukka.json' });
  assert.equal(escape.code, 1);
  assert.match(escape.out, /config must be a path inside the project/);
});

test('shu-9zr: a check runs each of its commands in its directory and fails on the first that fails', async () => {
  const ws = workspace();
  const check = fixtureConfig.checks[0] as Loose;
  const ok = await runStep(ws, pipeline, 'checks', 'Run the check', { 'toJSON(matrix.check)': JSON.stringify({ ...check, services: [] }) });
  assert.equal(ok.code, 0, ok.out);
  assert.ok(existsSync(join(ws.project, 'check-ran.txt')));
  const failing = await runStep(ws, pipeline, 'checks', 'Run the check', { 'toJSON(matrix.check)': JSON.stringify({ name: 'lint', dir: '.', run: ['false', 'touch never.txt'], services: [] }) });
  assert.equal(failing.code, 1);
  assert.match(failing.out, /::error::shukka: check lint failed at command 1/);
  assert.ok(!existsSync(join(ws.project, 'never.txt')));
});

test('shu-9zr: build runs the app\'s commands with its env and repository variables, bundles and tars the printed directory', async () => {
  const ws = workspace();
  const app = JSON.stringify({ ...fixtureConfig.apps[0] });
  const r = await runStep(ws, pipeline, 'build', 'Build and bundle', { 'toJSON(matrix.app)': app, 'toJSON(vars)': JSON.stringify({ SHUKKATEST_GREETING: 'hello', OTHER: 'x' }) });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /build output goes to the log/);
  const listing = execFileSync('tar', ['-tzf', join(ws.temp, 'shukka-bundle', 'bundle.tgz')], { encoding: 'utf8' });
  assert.match(listing, /greeting\.txt/);
  const greeting = execFileSync('tar', ['-xzOf', join(ws.temp, 'shukka-bundle', 'bundle.tgz'), './greeting.txt'], { encoding: 'utf8' });
  assert.equal(greeting, 'hello plain\n');
  // The artifact step uploads exactly that file under bundle-<app>.
  const upload = step(pipeline, 'build', 'Upload the bundle');
  assert.equal(upload.with.name, 'bundle-${{ matrix.app.name }}');
  assert.equal(upload.with.path, '${{ runner.temp }}/shukka-bundle/bundle.tgz');

  const missing = await runStep(ws, pipeline, 'build', 'Build and bundle', { 'toJSON(matrix.app)': app, 'toJSON(vars)': '{}' });
  assert.equal(missing.code, 1);
  assert.match(missing.out, /needs the repository variable SHUKKATEST_GREETING/);
});

test('shu-9zr: a failing smoke command prints the agreed line after the project\'s own output and fails the job', async () => {
  const ws = workspace();
  const exprs = { 'fromJSON(needs.plan.outputs.config).smoke.run': 'bash smoke.sh' };
  const ok = await runStep(ws, pipeline, 'smoke', 'Smoke test', exprs);
  assert.equal(ok.code, 0, ok.out);
  const failing = await runStep(ws, pipeline, 'smoke', 'Smoke test', exprs, { SMOKE_EXIT: '3' });
  assert.equal(failing.code, 1);
  const printed = lines(failing.out);
  const own = printed.indexOf('smoke: checking the site');
  const stop = printed.findIndex((l) => /^::error::shukka: the site is live but failing its smoke test/.test(l));
  assert.ok(own >= 0 && stop > own, failing.out);
  assert.match(printed[stop] as string, /exited 3/);
});

test('shu-9zr: infra changes decides with changed.mjs --part infra over the synthesized stacks, and counts an unreadable part as changed', async () => {
  const ws = workspace();
  const exprs = { 'inputs.config': 'shukka.json', 'steps.stacks.outputs.stacks': 'Shukkatest-Box,Shukkatest-Ci', 'inputs.force': 'false' };
  const tagged = (sha: string) => [{ StackName: 'Shukkatest-Box', Tags: [{ Key: 'shukka:revision', Value: sha }] }, { StackName: 'Shukkatest-Ci', Tags: [{ Key: 'shukka:revision', Value: sha }] }];

  const unchanged = await runStep(ws, infra, 'changes', 'Decide whether the stacks changed', exprs, { FAKE_WORLD: JSON.stringify({ stacks: tagged(ws.commits.c1 as string) }) });
  assert.equal(unchanged.code, 0, unchanged.out);
  assert.equal(unchanged.outputs.changed, 'false');
  assert.match(unchanged.out, /infrastructure has not changed since [0-9a-f]{40}; nothing to deploy/);
  const call = unchanged.calls[0] as Loose;
  assert.deepEqual(call.args, ['project/shukka.json', '--part', 'infra', '--repo', 'project', '--stacks', 'Shukkatest-Box,Shukkatest-Ci']);
  assert.ok(call.sent.every((s: Loose) => s.client === 'cfn'), 'only stacks are read under the infra role');

  writeFileSync(join(ws.project, 'infra/bin/app.mjs'), 'v2');
  sh(ws.project, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qam', 'infra');
  const changed = await runStep(ws, infra, 'changes', 'Decide whether the stacks changed', exprs, { FAKE_WORLD: JSON.stringify({ stacks: tagged(ws.commits.c1 as string) }) });
  assert.equal(changed.outputs.changed, 'true');

  const denied = await runStep(ws, infra, 'changes', 'Decide whether the stacks changed', { ...exprs, 'steps.stacks.outputs.stacks': '' }, { FAKE_WORLD: JSON.stringify({ awsError: 'AccessDenied' }) });
  assert.equal(denied.code, 0, denied.out);
  assert.equal(denied.outputs.changed, 'true');
  assert.deepEqual((denied.calls[0] as Loose).args, ['project/shukka.json', '--part', 'infra', '--repo', 'project']);

  const forced = await runStep(ws, infra, 'changes', 'Decide whether the stacks changed', { ...exprs, 'inputs.force': 'true' }, { FAKE_WORLD: JSON.stringify({ stacks: tagged(ws.commits.c3 as string) }) });
  assert.equal(forced.outputs.changed, 'true');
  assert.ok((forced.calls[0] as Loose).args.includes('--force'));

  const broken = await runStep(ws, infra, 'changes', 'Decide whether the stacks changed', { ...exprs, 'inputs.config': 'missing.json' });
  assert.equal(broken.code, 0);
  assert.equal(broken.outputs.changed, 'true');
  assert.match(broken.out, /::warning::shukka: could not decide whether the stacks changed; deploying them/);
});

const diffFixture = (name: string) => join(root, 'test', 'fixtures', 'diff', name);
const deployExprs = (allow: string, event: string) => ({ 'steps.config.outputs.infra_dir': 'infra', 'inputs.allow_replacement': allow, 'github.event_name': event });

test('shu-9zr: infra deploy writes ### Infrastructure changes and ### Guard, prints guard.mjs unchanged and stops on a destructive diff', async () => {
  const ws = workspace();
  const r = await runStep(ws, infra, 'deploy', 'Diff and guard', deployExprs('false', 'push'), { FAKE_DIFF: diffFixture('removed.txt') });
  assert.equal(r.code, 1, r.out);
  assert.deepEqual(r.npx, [`--no-install cdk diff --app ${ws.temp}/cdk.out --no-color`]);
  const printed = lines(r.out);
  const header = printed.indexOf('guard: these changes delete or replace a resource:');
  assert.ok(header >= 0, r.out);
  assert.equal(printed[header + 1], '[-] AWS::DynamoDB::Table GoneRetain orphan');
  assert.ok(printed.includes('guard: stopping. If this is intended, run the workflow by hand on main with allow_replacement ticked.'));
  assert.match(r.summary, /^### Infrastructure changes\n\n```\n[\s\S]*AWS::DynamoDB::Table GoneRetain[\s\S]*\n```\n/m);
  assert.match(r.summary, /^### Guard\n/m);
  assert.ok(r.summary.indexOf('### Infrastructure changes') < r.summary.indexOf('### Guard'));

  const safe = await runStep(ws, infra, 'deploy', 'Diff and guard', deployExprs('false', 'push'), { FAKE_DIFF: diffFixture('same.txt') });
  assert.equal(safe.code, 0, safe.out);

  const incomplete = await runStep(ws, infra, 'deploy', 'Diff and guard', deployExprs('false', 'push'), { FAKE_DIFF: diffFixture('same.txt'), FAKE_DIFF_STATUS: '1' });
  assert.equal(incomplete.code, 1, 'a failed cdk diff stops the deploy');
});

test('shu-9zr: allow_replacement passes --allow to the guard only on a run started by hand', async () => {
  const ws = workspace();
  const byHand = await runStep(ws, infra, 'deploy', 'Diff and guard', deployExprs('true', 'workflow_dispatch'), { FAKE_DIFF: diffFixture('removed.txt') });
  assert.equal(byHand.code, 0, byHand.out);
  assert.match(byHand.out, /^guard: allowed by the person who started this run \(--allow\)$/m);
  const onPush = await runStep(ws, infra, 'deploy', 'Diff and guard', deployExprs('true', 'push'), { FAKE_DIFF: diffFixture('removed.txt') });
  assert.equal(onPush.code, 1);
  assert.match(onPush.out, /allow_replacement is honoured only when the workflow is run by hand/);
});

test('shu-9zr: infra deploy tags every stack shukka:revision=<sha>, keeping each stack\'s own tags', async () => {
  const ws = workspace();
  const assembly = join(ws.temp, 'cdk.out');
  mkdirSync(assembly);
  const head = sh(ws.project, 'rev-parse', 'HEAD');
  const manifest = (tags: (id: string) => Record<string, string>) => JSON.stringify({
    artifacts: {
      'Shukkatest-Ci.assets': { type: 'cdk:asset-manifest' },
      'Shukkatest-Ci': { type: 'aws:cloudformation:stack', displayName: 'Shukkatest-Ci', properties: { tags: tags('Ci') }, dependencies: ['Shukkatest-Box', 'Shukkatest-Ci.assets'] },
      'Shukkatest-Box': { type: 'aws:cloudformation:stack', displayName: 'Shukkatest-Box', properties: { tags: tags('Box') } },
    },
  });
  writeFileSync(join(assembly, 'manifest.json'), manifest(() => ({ Project: 'shukkatest' })));
  const same = await runStep(ws, infra, 'deploy', 'Deploy', { 'steps.config.outputs.infra_dir': 'infra' });
  assert.equal(same.code, 0, same.out);
  assert.equal(same.outputs.deployed, 'true');
  assert.deepEqual(same.npx, [`--no-install cdk deploy --app ${assembly} --require-approval never --no-color --all --tags Project=shukkatest --tags shukka:revision=${head}`]);

  writeFileSync(join(assembly, 'manifest.json'), manifest((id) => ({ Project: 'shukkatest', Part: id })));
  const each = await runStep(ws, infra, 'deploy', 'Deploy', { 'steps.config.outputs.infra_dir': 'infra' });
  assert.equal(each.code, 0, each.out);
  assert.deepEqual(each.npx, [
    `--no-install cdk deploy --app ${assembly} --require-approval never --no-color --exclusively Shukkatest-Box --tags Project=shukkatest --tags Part=Box --tags shukka:revision=${head}`,
    `--no-install cdk deploy --app ${assembly} --require-approval never --no-color --exclusively Shukkatest-Ci --tags Project=shukkatest --tags Part=Ci --tags shukka:revision=${head}`,
  ], 'dependencies first');

  const failed = await runStep(ws, infra, 'deploy', 'Deploy', { 'steps.config.outputs.infra_dir': 'infra' }, { FAKE_DEPLOY_STATUS: '1' });
  assert.equal(failed.code, 1);
  assert.equal(failed.outputs.deployed, undefined);
});

test('shu-9zr: the pull-request diff uses --method=template (or --no-change-set) and never fails for a destructive diff', async () => {
  const ws = workspace();
  const r = await runStep(ws, infra, 'diff', 'Diff and guard', { 'steps.config.outputs.infra_dir': 'infra' }, { FAKE_DIFF: diffFixture('removed.txt'), FAKE_CDK_METHOD: '1' });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.npx[1], `--no-install cdk diff --app ${ws.temp}/cdk.out --no-color --method=template`);
  assert.equal(r.outputs.guard_status, '1');
  assert.match(r.summary, /### Infrastructure changes[\s\S]*### Guard/);
  const old = await runStep(ws, infra, 'diff', 'Diff and guard', { 'steps.config.outputs.infra_dir': 'infra' }, { FAKE_DIFF: diffFixture('same.txt') });
  assert.equal(old.npx[1], `--no-install cdk diff --app ${ws.temp}/cdk.out --no-color --no-change-set`);
  assert.equal(old.outputs.guard_status, '0');
});

async function fakeApi(handler: (req: IncomingMessage, body: string, res: ServerResponse) => void) {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => handler(req, body, res));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
  };
}

test('shu-9zr: the PR comment is marked <!-- shukka:diff -->, says the merge will stop, and is updated in place', async () => {
  const ws = workspace();
  writeFileSync(join(ws.temp, 'shukka-diff.txt'), readFileSync(diffFixture('removed.txt'), 'utf8'));
  writeFileSync(join(ws.temp, 'shukka-guard.txt'), 'guard: these changes delete or replace a resource:\n[-] AWS::DynamoDB::Table GoneRetain orphan\n');
  const comments: Loose[] = [{ id: 7, user: { login: 'someone' }, body: '<!-- shukka:diff --> planted by a person' }];
  const requests: string[] = [];
  const api = await fakeApi((req, body, res) => {
    requests.push(`${req.method} ${req.url}`);
    assert.equal(req.headers.authorization, 'Bearer t0ken');
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET') {
      res.end(JSON.stringify(new URL(req.url ?? '', 'http://x').searchParams.get('page') === '1' ? comments : []));
    } else if (req.method === 'POST') {
      comments.push({ id: 8, user: { login: 'github-actions[bot]' }, body: JSON.parse(body).body });
      res.end('{}');
    } else {
      const c = comments.find((x) => req.url?.endsWith(`/issues/comments/${x.id}`));
      assert.ok(c);
      c.body = JSON.parse(body).body;
      res.end('{}');
    }
  });
  try {
    const exprs = { 'github.token': 't0ken', 'github.event.pull_request.number': '12', 'steps.guard.outputs.guard_status': '1' };
    const env = { GITHUB_API_URL: api.url, GITHUB_REPOSITORY: 'acme/site' };
    const first = await runStep(ws, infra, 'diff', 'Comment on the pull request', exprs, env);
    assert.equal(first.code, 0, first.out);
    const ours = comments.filter((c) => c.user.login === 'github-actions[bot]');
    assert.equal(ours.length, 1);
    assert.match(ours[0]?.body, /^<!-- shukka:diff -->\n### Infrastructure changes\n\n\*\*This merge will stop\*\*/);
    assert.match(ours[0]?.body, /GoneRetain/);
    assert.match(ours[0]?.body, /### Guard/);
    assert.equal(comments[0]?.body, '<!-- shukka:diff --> planted by a person', 'another user\'s comment is never edited');

    const second = await runStep(ws, infra, 'diff', 'Comment on the pull request', { ...exprs, 'steps.guard.outputs.guard_status': '0' }, env);
    assert.equal(second.code, 0, second.out);
    assert.equal(comments.length, 2, 'updated, not posted again');
    assert.doesNotMatch(comments[1]?.body, /stop/);
    assert.ok(requests.includes('PATCH /repos/acme/site/issues/comments/8'));
  } finally {
    await api.close();
  }
});

test('shu-9zr: credentialed jobs read the shukka repository and commit from their OIDC token and refuse a token for another file', async () => {
  const claims = { job_workflow_ref: 'rummykhan/shukka/.github/workflows/infra.yml@refs/tags/v1', job_workflow_sha: SHUKKA_REPO_SHA, sub: 'repo:acme/site:ref:refs/heads/main' };
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  let audience = '';
  const api = await fakeApi((req, _body, res) => {
    assert.equal(req.headers.authorization, 'bearer request-token');
    audience = new URL(req.url ?? '', 'http://x').searchParams.get('audience') ?? '';
    res.end(JSON.stringify({ value: `${b64({ alg: 'RS256' })}.${b64(claims)}.sig` }));
  });
  try {
    const ws = workspace();
    const env = { ACTIONS_ID_TOKEN_REQUEST_URL: `${api.url}/token?api-version=2.0`, ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-token' };
    const r = await runStep(ws, infra, 'deploy', 'Find the shukka commit this job runs', {}, env);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(r.outputs, { repository: 'rummykhan/shukka', sha: SHUKKA_REPO_SHA });
    assert.equal(audience, 'shukka', 'not an STS audience');
    assert.doesNotMatch(r.out, /request-token|\.sig/);
    const other = await runStep(ws, ec2, 'release', 'Find the shukka commit this job runs', {}, env);
    assert.equal(other.code, 1, 'ec2.yml refuses a token naming infra.yml');
  } finally {
    await api.close();
  }
});

test('shu-9zr: ec2 changes decides every app with changed.mjs --part app:<name> and hands the release matrix only the changed ones', async () => {
  const ws = workspace();
  const exprs = { 'inputs.config': 'shukka.json', 'steps.config.outputs.apps': '["web","api"]', 'inputs.force': 'false' };
  const { c1, c2, c3 } = ws.commits as Record<string, string>;
  const r = await runStep(ws, ec2, 'changes', 'Decide which apps changed', exprs, { FAKE_WORLD: JSON.stringify({ revisions: { web: c1, api: c1 } }) });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.outputs, { apps: '["web"]', any: 'true' });
  assert.deepEqual((r.calls[0] as Loose).args, ['project/shukka.json', '--repo', 'project', '--part', 'app:web', '--part', 'app:api']);
  assert.ok((r.calls[0] as Loose).sent.every((s: Loose) => s.client !== 'cfn'), 'no stack is read under the app role');

  const docsOnly = await runStep(ws, ec2, 'changes', 'Decide which apps changed', exprs, { FAKE_WORLD: JSON.stringify({ revisions: { web: c3, api: c2 } }) });
  assert.deepEqual(docsOnly.outputs, { apps: '[]', any: 'false' });

  const unreadable = await runStep(ws, ec2, 'changes', 'Decide which apps changed', exprs, { FAKE_WORLD: JSON.stringify({ awsError: 'AccessDenied' }) });
  assert.deepEqual(unreadable.outputs, { apps: '["web","api"]', any: 'true' });

  const broken = await runStep(ws, ec2, 'changes', 'Decide which apps changed', { ...exprs, 'inputs.config': 'missing.json' });
  assert.deepEqual(broken.outputs, { apps: '["web","api"]', any: 'true' });
  assert.match(broken.out, /::warning::shukka: could not decide which apps changed; releasing every app/);
});

test('shu-9zr: ec2 config resolves the deploy bucket from the input or <project>-deploy-<account>', async () => {
  const ws = workspace();
  const r = await runStep(ws, ec2, 'changes', 'Read shukka.json', { 'inputs.config': 'shukka.json', 'inputs.deploy_bucket': '' }, { SHUKKA_NODE: process.execPath });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.outputs.bucket, 'shukkatest-deploy-123456789012');
  assert.equal(r.outputs.apps, '["web","api"]');
  const given = await runStep(ws, ec2, 'changes', 'Read shukka.json', { 'inputs.config': 'shukka.json', 'inputs.deploy_bucket': 'my-bucket' }, { SHUKKA_NODE: process.execPath });
  assert.equal(given.outputs.bucket, 'my-bucket');
  const bad = await runStep(ws, ec2, 'changes', 'Read shukka.json', { 'inputs.config': 'shukka.json', 'inputs.deploy_bucket': 'Bad Bucket' }, { SHUKKA_NODE: process.execPath });
  assert.equal(bad.code, 1);
});

test('shu-9zr: ec2 release unpacks the artifact outside both checkouts, uploads it and releases with the hook from git', async () => {
  const ws = workspace();
  // The artifact as build uploads it: a tarball of the bundle directory.
  const bundleDir = join(ws.temp, 'built');
  mkdirSync(join(bundleDir, 'box'), { recursive: true });
  writeFileSync(join(bundleDir, 'server.py'), 'print(1)\n');
  writeFileSync(join(bundleDir, 'box', 'configure.sh'), 'echo planted in the bundle\n');
  mkdirSync(join(ws.temp, 'shukka-artifact', 'web'), { recursive: true });
  execFileSync('tar', ['-C', bundleDir, '-czf', join(ws.temp, 'shukka-artifact', 'web', 'bundle.tgz'), '.']);

  const unpack = await runStep(ws, ec2, 'release', 'Unpack the bundle', { 'matrix.app': 'web' });
  assert.equal(unpack.code, 0, unpack.out);
  assert.ok(existsSync(join(ws.temp, 'shukka-bundle', 'web', 'server.py')));

  const exprs = { 'matrix.app': 'web', 'inputs.config': 'shukka.json', 'needs.changes.outputs.bucket': 'shukkatest-deploy-123456789012' };
  const head = sh(ws.project, 'rev-parse', 'HEAD');
  const upload = await runStep(ws, ec2, 'release', 'Upload the bundle', exprs);
  assert.equal(upload.code, 0, upload.out);
  const put = (upload.calls[0] as Loose).sent.find((s: Loose) => s.command === 'PutObjectCommand');
  assert.equal(put.input.Key, `shukkatest/web/${head}.tgz`);
  assert.equal(put.input.Bucket, 'shukkatest-deploy-123456789012');

  const release = await runStep(ws, ec2, 'release', 'Release', exprs);
  assert.equal(release.code, 0, release.out);
  const call = release.calls[0] as Loose;
  assert.deepEqual(call.args, ['--bucket', 'shukkatest-deploy-123456789012', '--sha', head, '--checkout', 'project', '--config', 'project/shukka.json', '--app', 'web']);
  const hook = call.sent.find((s: Loose) => s.command === 'PutObjectCommand');
  assert.equal(hook.input.Key, `shukkatest/web/${head}.configure.sh`);
  assert.equal(Buffer.from(hook.input.Body).toString(), '#!/bin/sh\necho configure from git\n');
  const send = call.sent.find((s: Loose) => s.command === 'SendCommandCommand');
  assert.deepEqual(send.input.InstanceIds, ['i-0123456789abcdef0'], 'instances resolved from the Project tag, no Targets');
  assert.equal(send.input.Targets, undefined);
  assert.match(send.input.Parameters.commands.join('\n'), /--configure-key/);
});
