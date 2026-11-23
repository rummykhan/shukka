// tagProject (lib/project-tags.ts): every request that creates an EC2 resource carries Project=<project>, which the
// fence requires (aws:RequestTag/Project on RunInstances, CreateSecurityGroup, CreateLaunchTemplate, AllocateAddress,
// CreateVolume). Checked on the acceptance consumer's real synth and on small stacks.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { App, CfnParameter, Size, Stack, Tags } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { tagProject } from '../lib/index.js';

type Loose = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(tmpdir(), 'shukka-project-tags-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;

/** The acceptance consumer's infra (test/acceptance/consumer/infra), synthesized offline with this checkout as `shukka`. */
function synthConsumer(): string {
  const dir = join(scratch, `consumer-${++n}`);
  const infra = join(dir, 'infra');
  const src = join(root, 'test', 'acceptance', 'consumer');
  cpSync(join(src, 'infra', 'bin'), join(infra, 'bin'), { recursive: true });
  cpSync(join(src, 'infra', 'lib'), join(infra, 'lib'), { recursive: true });
  cpSync(join(src, 'infra', 'settings.json'), join(infra, 'settings.json'));
  cpSync(join(src, 'probe', 'targets.json'), join(dir, 'probe', 'targets.json'));
  writeFileSync(join(infra, 'env.json'), JSON.stringify({
    account: '123456789012', region: 'us-east-1', runId: '1', githubRepoSubject: 'rummykhan/shukka-consumer-test',
    oidcProviderArn: 'arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com', hostedZoneId: 'Z0123456789ABC',
    zoneName: 'shukkatest.example.com', vpcId: 'vpc-0123456789abcdef0', subnetId: 'subnet-0123456789abcdef0',
    availabilityZone: 'us-east-1a', amiId: 'ami-0123456789abcdef0',
  }));
  const modules = join(infra, 'node_modules');
  mkdirSync(join(modules, 'shukka'), { recursive: true });
  for (const m of ['aws-cdk-lib', 'constructs', 'tsx']) symlinkSync(join(root, 'node_modules', m), join(modules, m));
  writeFileSync(join(modules, 'shukka', 'package.json'), JSON.stringify({ name: 'shukka', type: 'module', main: 'index.ts' }));
  writeFileSync(join(modules, 'shukka', 'index.ts'), `export * from ${JSON.stringify(join(root, 'lib', 'index.ts'))};\n`);
  const out = join(dir, 'cdk.out');
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'bin/app.mjs'], { cwd: infra, env: { ...process.env, CDK_OUTDIR: out }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return out;
}

const hasProject = (tags: Loose[] | undefined) => (tags ?? []).some((t) => (t.Key ?? t.key) === 'Project' && (t.Value ?? t.value) === 'shukkatest');
const specFor = (specs: Loose[] | undefined, type: string): Loose | undefined => (specs ?? []).find((s) => s.ResourceType === type);

/**
 * For each EC2 resource whose create the fence ties to aws:RequestTag/Project: where in its CloudFormation properties
 * the tag must be for CloudFormation to send it with the create call.
 */
function createTagged(r: Loose): Loose[] | undefined {
  switch (r.Type) {
    case 'AWS::EC2::Instance': // RunInstances
    case 'AWS::EC2::SecurityGroup': // CreateSecurityGroup
    case 'AWS::EC2::EIP': // AllocateAddress
    case 'AWS::EC2::Volume': // CreateVolume
      return r.Properties?.Tags;
    case 'AWS::EC2::LaunchTemplate': // CreateLaunchTemplate
      return specFor(r.Properties?.TagSpecifications, 'launch-template')?.Tags;
    default:
      return undefined;
  }
}
const CREATE_TYPES = ['AWS::EC2::Instance', 'AWS::EC2::SecurityGroup', 'AWS::EC2::EIP', 'AWS::EC2::Volume', 'AWS::EC2::LaunchTemplate'];

test('shu-9bj.18: synth of the consumer shows the launch template\'s TagSpecifications include launch-template with Project', () => {
  const box = JSON.parse(readFileSync(join(synthConsumer(), 'Shukkatest-Box.template.json'), 'utf8'));
  const lts = (Object.values(box.Resources) as Loose[]).filter((r) => r.Type === 'AWS::EC2::LaunchTemplate');
  assert.equal(lts.length, 1, 'the box has the launch template ec2.Instance makes for requireImdsv2');
  const lt = lts[0] as Loose;
  assert.deepEqual(specFor(lt.Properties.TagSpecifications, 'launch-template'), { ResourceType: 'launch-template', Tags: [{ Key: 'Project', Value: 'shukkatest' }] });
  // What an instance launched from it creates is the project's too.
  for (const t of ['instance', 'volume', 'network-interface']) {
    assert.ok(hasProject(specFor(lt.Properties.LaunchTemplateData.TagSpecifications, t)?.Tags), `launch template data tags ${t}`);
  }
  assert.equal(lt.Properties.LaunchTemplateData.MetadataOptions.HttpTokens, 'required', 'IMDSv2 is still required');
});

test('shu-9bj.18: every EC2 create the fence tag-checks in the consumer (instance, security group, EIP, launch template) carries Project on create', () => {
  const box = JSON.parse(readFileSync(join(synthConsumer(), 'Shukkatest-Box.template.json'), 'utf8'));
  const seen = new Set<string>();
  for (const [id, r] of Object.entries(box.Resources) as [string, Loose][]) {
    if (!CREATE_TYPES.includes(r.Type)) continue;
    seen.add(r.Type);
    assert.ok(hasProject(createTagged(r)), `${id} (${r.Type}) creates without Project=shukkatest`);
  }
  assert.deepEqual([...seen].sort(), ['AWS::EC2::EIP', 'AWS::EC2::Instance', 'AWS::EC2::LaunchTemplate', 'AWS::EC2::SecurityGroup']);
});

function stackWith(build: (s: Stack, vpc: ec2.IVpc) => void, tag: (app: App) => void): Loose {
  const app = new App();
  const s = new Stack(app, 'Shukkatest-T', { env: { account: '123456789012', region: 'us-east-1' } });
  const vpc = ec2.Vpc.fromVpcAttributes(s, 'Vpc', { vpcId: 'vpc-1', availabilityZones: ['us-east-1a'], publicSubnetIds: ['subnet-1'] });
  build(s, vpc);
  tag(app);
  return Template.fromStack(s).toJSON();
}

test('shu-9bj.18: Tags.of alone leaves the requireImdsv2 launch template untagged on create (the refused request); tagProject fixes it', () => {
  const box = (s: Stack, vpc: ec2.IVpc) => new ec2.Instance(s, 'Box', {
    vpc, instanceType: new ec2.InstanceType('t4g.nano'), machineImage: ec2.MachineImage.genericLinux({ 'us-east-1': 'ami-1' }), requireImdsv2: true,
  });
  const before = stackWith(box, (app) => Tags.of(app).add('Project', 'shukkatest'));
  const ltBefore = (Object.values(before.Resources) as Loose[]).find((r) => r.Type === 'AWS::EC2::LaunchTemplate') as Loose;
  assert.equal(hasProject(createTagged(ltBefore)), false);
  const fixed = stackWith(box, (app) => tagProject(app, 'shukkatest'));
  for (const r of Object.values(fixed.Resources) as Loose[]) {
    if (CREATE_TYPES.includes(r.Type)) assert.ok(hasProject(createTagged(r)), r.Type);
  }
});

test('shu-9bj.18: tagProject tags a volume, an ec2.LaunchTemplate and an L1 launch template with its own tags, keeping theirs', () => {
  const t = stackWith((s, vpc) => {
    new ec2.Volume(s, 'Data', { availabilityZone: 'us-east-1a', size: Size.gibibytes(8) });
    new ec2.SecurityGroup(s, 'Sg', { vpc });
    new ec2.CfnEIP(s, 'Ip', { domain: 'vpc' });
    new ec2.LaunchTemplate(s, 'L2', { launchTemplateName: 'shukkatest-l2', requireImdsv2: true });
    new ec2.CfnLaunchTemplate(s, 'L1', {
      launchTemplateName: 'shukkatest-l1',
      tagSpecifications: [{ resourceType: 'launch-template', tags: [{ key: 'Team', value: 'ops' }, { key: 'Project', value: 'wrong' }] }],
      launchTemplateData: { tagSpecifications: [{ resourceType: 'instance', tags: [{ key: 'Name', value: 'web' }] }] },
    });
  }, (app) => tagProject(app, 'shukkatest'));
  const res = t.Resources as Record<string, Loose>;
  for (const [id, r] of Object.entries(res)) {
    if (CREATE_TYPES.includes(r.Type)) assert.ok(hasProject(createTagged(r)), `${id} (${r.Type})`);
  }
  const l1 = Object.values(res).find((r) => r.Properties?.LaunchTemplateName === 'shukkatest-l1') as Loose;
  assert.deepEqual(specFor(l1.Properties.TagSpecifications, 'launch-template')?.Tags, [{ Key: 'Team', Value: 'ops' }, { Key: 'Project', Value: 'shukkatest' }]);
  assert.deepEqual(specFor(l1.Properties.LaunchTemplateData.TagSpecifications, 'instance')?.Tags, [{ Key: 'Name', Value: 'web' }, { Key: 'Project', Value: 'shukkatest' }]);
  const l2 = Object.values(res).find((r) => r.Properties?.LaunchTemplateName === 'shukkatest-l2') as Loose;
  assert.equal(specFor(l2.Properties.TagSpecifications, 'launch-template')?.Tags.filter((x: Loose) => x.Key === 'Project').length, 1);
});

const ltOf = (t: Loose): [string, Loose][] => (Object.entries(t.Resources) as [string, Loose][]).filter(([, r]) => r.Type === 'AWS::EC2::LaunchTemplate');
const imdsBox = (s: Stack, vpc: ec2.IVpc) => new ec2.Instance(s, 'Box', {
  vpc, instanceType: new ec2.InstanceType('t4g.nano'), machineImage: ec2.MachineImage.genericLinux({ 'us-east-1': 'ami-1' }), requireImdsv2: true,
});

test('shu-9bj.20: synth of the consumer names the requireImdsv2 launch template with the project prefix, and the instance launches from that name', () => {
  const box = JSON.parse(readFileSync(join(synthConsumer(), 'Shukkatest-Box.template.json'), 'utf8'));
  const lts = ltOf(box);
  assert.equal(lts.length, 1);
  const [id, lt] = lts[0] as [string, Loose];
  const name = lt.Properties.LaunchTemplateName as string;
  assert.ok(name.startsWith('shukkatest'), name);
  assert.match(name, /^[a-zA-Z0-9().\-/_]{3,128}$/);
  const inst = (Object.values(box.Resources) as Loose[]).find((r) => r.Type === 'AWS::EC2::Instance') as Loose;
  assert.equal(inst.Properties.LaunchTemplate.LaunchTemplateName, name, 'the instance references the renamed template');
  assert.deepEqual(inst.Properties.LaunchTemplate.Version, { 'Fn::GetAtt': [id, 'LatestVersionNumber'] });
});

test('shu-9bj.20: two projects in one app with an instance called Box get different, project-prefixed launch template names, the same each synth', () => {
  const synth = () => {
    const app = new App();
    const names: string[] = [];
    const stacks: Stack[] = [];
    for (const p of ['alpha', 'beta']) {
      const s = new Stack(app, `${p}-Box`, { env: { account: '123456789012', region: 'us-east-1' } });
      const vpc = ec2.Vpc.fromVpcAttributes(s, 'Vpc', { vpcId: 'vpc-1', availabilityZones: ['us-east-1a'], publicSubnetIds: ['subnet-1'] });
      imdsBox(s, vpc);
      tagProject(s, p);
      stacks.push(s);
    }
    for (const [i, s] of stacks.entries()) {
      const t = Template.fromStack(s).toJSON();
      const lts = ltOf(t);
      assert.equal(lts.length, 1);
      const name = (lts[0] as [string, Loose])[1].Properties.LaunchTemplateName as string;
      assert.ok(name.startsWith(i === 0 ? 'alpha' : 'beta'), name);
      const inst = (Object.values(t.Resources) as Loose[]).find((r) => r.Type === 'AWS::EC2::Instance') as Loose;
      assert.equal(inst.Properties.LaunchTemplate.LaunchTemplateName, name);
      names.push(name);
    }
    return names;
  };
  const first = synth();
  assert.notEqual(first[0], first[1]);
  assert.deepEqual(synth(), first, 'deterministic across synths');
});

test('shu-9bj.20: names already starting with the project are left alone; long or odd names stay within EC2 rules; absent stays absent', () => {
  const long = 'x'.repeat(126);
  const t = stackWith((s) => {
    new ec2.CfnLaunchTemplate(s, 'Own', { launchTemplateName: 'shukkatest-own', launchTemplateData: {} });
    new ec2.CfnLaunchTemplate(s, 'Long', { launchTemplateName: long, launchTemplateData: {} });
    new ec2.CfnLaunchTemplate(s, 'Odd', { launchTemplateName: 'web server#1', launchTemplateData: {} });
    new ec2.CfnLaunchTemplate(s, 'None', { launchTemplateData: {} });
  }, (app) => tagProject(app, 'shukkatest'));
  const byId = Object.fromEntries(ltOf(t).map(([id, r]) => [id.replace(/[A-F0-9]{8}$/, ''), r.Properties.LaunchTemplateName]));
  assert.equal(byId.Own, 'shukkatest-own');
  assert.equal(byId.None, undefined);
  for (const k of ['Long', 'Odd']) {
    assert.ok((byId[k] as string).startsWith('shukkatest-'), byId[k]);
    assert.match(byId[k] as string, /^[a-zA-Z0-9().\-/_]{3,128}$/, k);
  }
  assert.equal(byId.Odd, 'shukkatest-web-server-1');
});

test('shu-9bj.20: a token launch template name is left alone with a synth warning', () => {
  const app = new App();
  const s = new Stack(app, 'Shukkatest-T', { env: { account: '123456789012', region: 'us-east-1' } });
  const p = new CfnParameter(s, 'LtName');
  new ec2.CfnLaunchTemplate(s, 'Tok', { launchTemplateName: p.valueAsString, launchTemplateData: {} });
  tagProject(app, 'shukkatest');
  const t = Template.fromStack(s);
  const [, lt] = ltOf(t.toJSON())[0] as [string, Loose];
  assert.deepEqual(lt.Properties.LaunchTemplateName, { Ref: 'LtName' });
  const warnings = Annotations.fromStack(s).findWarning('*', Match.stringLikeRegexp('LaunchTemplateName'));
  assert.equal(warnings.length, 1, JSON.stringify(warnings));
});
