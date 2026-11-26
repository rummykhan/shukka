// shu-wud: a stack in a state no update can leave stops the deploy before cdk, naming the stack, its state and what an
// admin does, instead of cdk failing on the deploy role's DeleteStack deny. scripts/stack-state.mjs is shared by
// infra.yml's deploy job (tested in workflows.test.ts) and `shukka deploy` (checkStacksDeployable, here).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STUCK, main, readStackStates, stuckStacks, summary } from '../scripts/stack-state.mjs';
import { checkStacksDeployable } from '../scripts/cli/deploy.mjs';
import { CliError, createIo } from '../scripts/cli/exec.mjs';
import type { Config } from '../scripts/config.mjs';
import type { Aws } from '../scripts/cli/aws.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'shu-wud-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const STATES = ['ROLLBACK_FAILED', 'ROLLBACK_COMPLETE', 'UPDATE_ROLLBACK_FAILED', 'DELETE_FAILED', 'REVIEW_IN_PROGRESS'];

/** A CloudFormation client answering DescribeStacks from `stacks` (name -> status); a name absent does not exist. */
function fakeCfn(stacks: Record<string, string>, asked: string[] = []) {
  return {
    async send(c: { input: { StackName: string } }) {
      asked.push(c.input.StackName);
      const status = stacks[c.input.StackName];
      if (status === undefined) throw Object.assign(new Error(`Stack with id ${c.input.StackName} does not exist`), { name: 'ValidationError' });
      if (status === 'DENIED') throw Object.assign(new Error('User is not authorized to perform: cloudformation:DescribeStacks'), { name: 'AccessDenied' });
      return { Stacks: [{ StackName: c.input.StackName, StackStatus: status }] };
    },
  };
}

test('shu-bca: UPDATE_ROLLBACK_FAILED names continue-update-rollback with --resources-to-skip <logical id>, and the summary shows the placeholder', () => {
  const [s] = stuckStacks([{ name: 'Acme-Web', status: 'UPDATE_ROLLBACK_FAILED' }]);
  assert.ok(s);
  assert.match(s.advice, /aws cloudformation continue-update-rollback --stack-name Acme-Web --resources-to-skip <logical id>/);
  assert.match(s.advice, /only resources that failed during the rollback can be skipped/);
  assert.match(s.advice, /admin credentials/);
  const md = summary([s]);
  assert.match(md, /--resources-to-skip &lt;logical id&gt;/, 'the placeholder is not swallowed as an HTML tag');
  assert.doesNotMatch(md, /<logical id>/);
});

test('shu-wud: each stuck state names the stack, the state and what an admin does; other states pass', () => {
  assert.deepEqual(Object.keys(STUCK).sort(), [...STATES].sort());
  for (const status of STATES) {
    const [s] = stuckStacks([{ name: 'Acme-Web', status }]);
    assert.ok(s, status);
    assert.equal(s.name, 'Acme-Web');
    assert.equal(s.status, status);
    assert.match(s.message, new RegExp(`^stack Acme-Web is in ${status}: `));
    assert.match(s.message, /admin credentials/);
    assert.match(s.message, /The deploy role may not delete stacks/);
    assert.doesNotMatch(s.message, /<stack>/);
    if (status === 'UPDATE_ROLLBACK_FAILED') assert.match(s.advice, /aws cloudformation continue-update-rollback --stack-name Acme-Web/);
    else assert.match(s.advice, /[Dd]elete it by hand with admin credentials \(aws cloudformation delete-stack --stack-name Acme-Web/);
  }
  for (const status of ['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE', 'IMPORT_COMPLETE', null]) {
    assert.deepEqual(stuckStacks([{ name: 'Acme-Web', status }]), [], String(status));
  }
});

test('shu-wud: stack states are read with DescribeStacks; a missing stack is null and an unreadable one is a warning', async () => {
  const warnings: string[] = [];
  const states = await readStackStates(['Acme-A', 'Acme-B', 'Acme-C'], fakeCfn({ 'Acme-A': 'ROLLBACK_FAILED', 'Acme-C': 'DENIED' }), (l) => warnings.push(l));
  assert.deepEqual(states, [{ name: 'Acme-A', status: 'ROLLBACK_FAILED' }, { name: 'Acme-B', status: null }]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] as string, /could not read the state of stack Acme-C/);
});

test('shu-wud: the CLI exits 1 on a stuck stack with an ::error:: line and a summary table, leaving out the CI stack', async () => {
  const file = join(scratch, 'summary.md');
  writeFileSync(file, '');
  let out = '';
  const asked: string[] = [];
  const code = await main(['--stacks', 'Acme-Web,Acme-Ci', '--project', 'acme', '--summary', file], { cfn: fakeCfn({ 'Acme-Web': 'UPDATE_ROLLBACK_FAILED', 'Acme-Ci': 'ROLLBACK_FAILED' }, asked), out: (t) => { out += t; } });
  assert.equal(code, 1);
  assert.deepEqual(asked, ['Acme-Web']);
  assert.match(out, /^::error::shukka: stack Acme-Web is in UPDATE_ROLLBACK_FAILED: .*continue-update-rollback --stack-name Acme-Web/m);
  const md = readFileSync(file, 'utf8');
  assert.equal(md, summary(stuckStacks([{ name: 'Acme-Web', status: 'UPDATE_ROLLBACK_FAILED' }])));
  assert.match(md, /^### Infrastructure not deployed: a stack is stuck$/m);
  assert.match(md, /^\| `Acme-Web` \| `UPDATE_ROLLBACK_FAILED` \| .*admin credentials.* \|$/m);

  writeFileSync(file, '');
  out = '';
  assert.equal(await main(['--stacks', 'Acme-Web', '--summary', file], { cfn: fakeCfn({ 'Acme-Web': 'UPDATE_COMPLETE' }), out: (t) => { out += t; } }), 0);
  assert.equal(readFileSync(file, 'utf8'), '');
  assert.match(out, /no stack is stuck \(1 checked\)/);
  const err: string[] = [];
  assert.equal(await main(['--project', 'acme'], { cfn: fakeCfn({}), err: (t) => err.push(t) }), 2);
  assert.equal(await main(['--stacks'], { cfn: fakeCfn({}), err: (t) => err.push(t) }), 2);
});

/** An assembly directory whose manifest has these top-level stacks. */
function assembly(names: string[]): string {
  const dir = mkdtempSync(join(scratch, 'cdk.out-'));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    artifacts: Object.fromEntries(names.map((n) => [n, { type: 'aws:cloudformation:stack', properties: { templateFile: `${n}.template.json` } }])),
  }));
  return dir;
}

const config = { project: 'acme', qualifier: 'acme', aws: { account: '123456789012', region: 'us-east-1' } } as unknown as Config;

/** An Aws whose describeStack answers from `stacks` (name -> status, or an Error to throw); records the names read. */
function fakeAws(stacks: Record<string, string | Error>, asked: string[] = []) {
  return {
    async describeStack(name: string) {
      asked.push(name);
      const status = stacks[name];
      if (status instanceof Error) throw status;
      return status === undefined ? null : { name, outputs: {}, tags: {}, status };
    },
  } as unknown as Aws;
}

test('shu-wud: shukka deploy refuses before cdk when a stack it deploys is stuck, and never reads the CI stack', async () => {
  for (const status of STATES) {
    let out = '';
    const io = createIo({ out: (t) => { out += t; }, err: () => {} });
    const asked: string[] = [];
    const aws = fakeAws({ 'Acme-Web': 'UPDATE_COMPLETE', 'Acme-Data': status, 'Acme-Ci': 'ROLLBACK_FAILED' }, asked);
    await assert.rejects(checkStacksDeployable(io, aws, config, assembly(['Acme-Web', 'Acme-Data', 'Acme-Ci'])), (e: Error) => {
      assert.ok(e instanceof CliError);
      assert.match(e.message, new RegExp(`^refusing to deploy:\\nstack Acme-Data is in ${status}: .*admin credentials`));
      assert.match(e.message, /(delete-stack|continue-update-rollback) --stack-name Acme-Data/);
      return true;
    }, status);
    assert.deepEqual(asked, ['Acme-Web', 'Acme-Data']);
    assert.equal(out, '');
  }
});

test('shu-wud: shukka deploy goes on when no stack is stuck or one cannot be read, and prints the step in a dry run without reading AWS', async () => {
  let out = '';
  let err = '';
  const io = createIo({ out: (t) => { out += t; }, err: (t) => { err += t; } });
  await checkStacksDeployable(io, fakeAws({ 'Acme-Db': new Error('AccessDenied: not authorized') }), config, assembly(['Acme-Web', 'Acme-Db']));
  assert.match(out, /shukka: stacks checked: none is stuck \(2\)/);
  assert.match(err, /warning: could not read the state of stack Acme-Db: AccessDenied/);

  out = '';
  const asked: string[] = [];
  const dry = createIo({ dryRun: true, out: (t) => { out += t; }, err: () => {} });
  await checkStacksDeployable(dry, fakeAws({}, asked), config, join(scratch, 'not-synthesized'));
  assert.deepEqual(asked, []);
  assert.match(out, /^\+ read the state of each stack to deploy; stop if one is ROLLBACK_COMPLETE, ROLLBACK_FAILED, UPDATE_ROLLBACK_FAILED, DELETE_FAILED or REVIEW_IN_PROGRESS {3}\[dry run: not run\]$/m);
});
