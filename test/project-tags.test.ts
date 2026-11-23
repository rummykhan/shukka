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
import { App, Size, Stack, Tags } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Template } from 'aws-cdk-lib/assertions';
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
