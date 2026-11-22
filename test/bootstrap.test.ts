import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import * as cxapi from 'aws-cdk-lib/cx-api';
import {
  ROLE_ARN_ACTIONS,
  SHUKKA_BOOTSTRAP_VERSION,
  bootstrapNames,
  bootstrapStackName,
  bootstrapTemplate,
  executionPolicyNames,
  inProjectPrefix,
  shukkaSynthesizer,
  unboundedRoles,
  type RoleReader,
} from '../lib/index.js';

type Statement = { Sid?: string; Effect: string; Action: string | string[]; Resource: unknown; Condition?: Record<string, Record<string, unknown>> };
type Resource = { Type: string; Properties: Record<string, unknown> };

const tpl = bootstrapTemplate({ project: 'trendigle' });
const resources = tpl.Resources as unknown as Record<string, Resource>;
const list = <T>(v: T | T[]): T[] => (Array.isArray(v) ? v : [v]);
const subOf = (v: unknown) => (v as { 'Fn::Sub': string })['Fn::Sub'];
const subs = (v: unknown) => list(v).map(subOf);
const rolesOf = () => Object.entries(resources).filter(([, r]) => r.Type === 'AWS::IAM::Role');
const statementsOf = (logicalId: string): Statement[] =>
  ((resources[logicalId]?.Properties.Policies ?? []) as { PolicyDocument: { Statement: Statement[] } }[]).flatMap((p) => p.PolicyDocument.Statement);

const EXEC = 'arn:${AWS::Partition}:iam::${AWS::AccountId}:role/cdk-trendigle-cfn-exec-role-${AWS::AccountId}-${AWS::Region}';
const STACKS = ['trendigle', 'Trendigle'].map((p) => `arn:\${AWS::Partition}:cloudformation:\${AWS::Region}:\${AWS::AccountId}:stack/${p}-*/*`);
const BUCKET = 'arn:${AWS::Partition}:s3:::cdk-trendigle-assets-${AWS::AccountId}-${AWS::Region}';

test('shu-9bj.2: the template is a CloudFormation template with the stock resource names and outputs', () => {
  const t = Template.fromJSON(tpl);
  t.hasResourceProperties('AWS::IAM::Role', { RoleName: { 'Fn::Sub': 'cdk-trendigle-deploy-role-${AWS::AccountId}-${AWS::Region}' } });
  t.hasResourceProperties('AWS::IAM::Role', { RoleName: { 'Fn::Sub': 'cdk-trendigle-file-publishing-role-${AWS::AccountId}-${AWS::Region}' } });
  t.hasResourceProperties('AWS::IAM::Role', { RoleName: { 'Fn::Sub': 'cdk-trendigle-cfn-exec-role-${AWS::AccountId}-${AWS::Region}' } });
  t.hasResourceProperties('AWS::S3::Bucket', { BucketName: { 'Fn::Sub': 'cdk-trendigle-assets-${AWS::AccountId}-${AWS::Region}' } });
  assert.deepEqual(Object.keys(tpl.Outputs as object).sort(), ['BootstrapVersion', 'BucketDomainName', 'BucketName']);
  assert.equal(tpl.Parameters, undefined, 'no parameters: nothing can widen it at deploy time');
  assert.equal(bootstrapStackName('trendigle'), 'CDKToolkit-trendigle');
  assert.ok(!bootstrapStackName('trendigle').startsWith('trendigle') && !bootstrapStackName('trendigle').startsWith('Trendigle'),
    'the bootstrap stack is outside the deploy role\'s own stacks');
  assert.throws(() => bootstrapTemplate({ project: 'trendigle', qualifier: 'Bad*' }), /qualifier/);
  assert.throws(() => bootstrapTemplate({ project: '*' }), /project name/);
});

test('shu-9bj.2: the deploy role allows CloudFormation only on the project stacks and only with the project execution role', () => {
  const sts = statementsOf('DeploymentActionRole');
  const cfnAllows = sts.filter((s) => s.Effect === 'Allow' && list(s.Action).some((a) => a.startsWith('cloudformation:')));
  assert.equal(cfnAllows.length, 1, 'one CloudFormation allow');
  const allow = cfnAllows[0]!;
  assert.deepEqual(subs(allow.Resource).sort(), [...STACKS].sort(), 'stack/<Project>-*/* and stack/<project>-*/* only');
  assert.equal(allow.Condition, undefined);
  for (const a of ['cloudformation:CreateChangeSet', 'cloudformation:ExecuteChangeSet', 'cloudformation:DescribeChangeSet', 'cloudformation:DeleteChangeSet',
    'cloudformation:DescribeStacks', 'cloudformation:GetTemplate', 'cloudformation:DeleteStack']) {
    assert.ok(list(allow.Action).includes(a), `${a} allowed on own stacks`);
  }

  const denies = sts.filter((s) => s.Effect === 'Deny');
  const absent = denies.find((s) => s.Condition?.Null?.['cloudformation:RoleArn'] === 'true');
  const other = denies.find((s) => s.Condition?.ArnNotEquals?.['cloudformation:RoleArn'] !== undefined);
  assert.ok(absent, 'deny when RoleArn is absent');
  assert.ok(other, 'deny when RoleArn is another role');
  assert.equal(subOf(other.Condition!.ArnNotEquals!['cloudformation:RoleArn']), EXEC);
  for (const d of [absent, other]) {
    assert.equal(d.Resource, '*');
    assert.deepEqual([...list(d.Action)].sort(), [...ROLE_ARN_ACTIONS].sort(), 'every action that takes a RoleArn');
  }
  // Every action the deploy role may perform that takes a RoleArn is covered by the denies.
  const allowed = sts.filter((s) => s.Effect === 'Allow').flatMap((s) => list(s.Action));
  for (const a of allowed.filter((x) => (ROLE_ARN_ACTIONS as readonly string[]).includes(x))) assert.ok(list(other.Action).includes(a));

  const pass = sts.find((s) => list(s.Action).includes('iam:PassRole'));
  assert.ok(pass);
  assert.deepEqual(subs(pass.Resource), [EXEC], 'passes only its own execution role');
  assert.deepEqual(pass.Condition, { StringEquals: { 'iam:PassedToService': 'cloudformation.amazonaws.com' } });

  const version = sts.find((s) => list(s.Action).includes('ssm:GetParameter'));
  assert.deepEqual(subs(version?.Resource), ['arn:${AWS::Partition}:ssm:${AWS::Region}:${AWS::AccountId}:parameter/cdk-bootstrap/trendigle/version']);

  // Nothing else with a wildcard resource is allowed, except calls with no resource type.
  for (const s of sts.filter((x) => x.Effect === 'Allow' && x.Resource === '*')) assert.deepEqual(list(s.Action), ['sts:GetCallerIdentity']);
  // Any S3 access is to the project's asset bucket, read only.
  for (const s of sts.filter((x) => list(x.Action).some((a) => a.startsWith('s3:')))) {
    assert.deepEqual(subs(s.Resource).sort(), [BUCKET, `${BUCKET}/*`].sort());
    assert.ok(list(s.Action).every((a) => /^s3:(Get|List)/.test(a)), 'read only');
  }
});

test('shu-9bj.2: the template has no lookup role and nothing with ReadOnlyAccess or another AWS managed policy', () => {
  const names = rolesOf().map(([id, r]) => `${id} ${subOf(r.Properties.RoleName)}`);
  assert.equal(rolesOf().length, 3, names.join(', '));
  assert.ok(names.every((n) => !/lookup/i.test(n)), 'no lookup role');
  const text = JSON.stringify(tpl);
  assert.doesNotMatch(text, /ReadOnlyAccess|AdministratorAccess|iam::aws:policy/);
  assert.doesNotMatch(text, /lookup-role/);
});

test('shu-9bj.2: the file-publishing role can write only the project asset bucket', () => {
  const sts = statementsOf('FilePublishingRole');
  assert.ok(sts.length > 0);
  for (const s of sts) {
    assert.equal(s.Effect, 'Allow');
    assert.deepEqual(subs(s.Resource).sort(), [BUCKET, `${BUCKET}/*`].sort());
    assert.ok(list(s.Action).every((a) => a.startsWith('s3:')), 'S3 only');
    assert.ok(!list(s.Action).some((a) => /Delete|^s3:\*$|^s3:Put(?!Object$)/.test(a)), `no deletes or bucket changes: ${list(s.Action)}`);
  }
  assert.ok(sts.some((s) => list(s.Action).includes('s3:PutObject')), 'can upload assets');
  const role = resources.FilePublishingRole!.Properties;
  assert.equal(role.ManagedPolicyArns, undefined);
  const bucket = resources.StagingBucket!.Properties;
  assert.deepEqual(bucket.PublicAccessBlockConfiguration, { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true });
  assert.ok(bucket.BucketEncryption, 'encrypted');
  assert.ok((bucket.LifecycleConfiguration as { Rules: unknown[] }).Rules.length > 0, 'lifecycle rules');
});

test('shu-9bj.2: the execution role carries the three execution managed policies from ShukkaBoundary and nothing else', () => {
  const role = resources.CloudFormationExecutionRole!.Properties;
  assert.deepEqual(subs(role.ManagedPolicyArns), executionPolicyNames('trendigle').map((p) => `arn:\${AWS::Partition}:iam::\${AWS::AccountId}:policy/${p}`));
  assert.equal(executionPolicyNames('trendigle').length, 3);
  assert.deepEqual(Object.keys(role).sort(), ['AssumeRolePolicyDocument', 'ManagedPolicyArns', 'RoleName'], 'no inline policies, no boundary to widen');
  assert.deepEqual(role.AssumeRolePolicyDocument, {
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Action: 'sts:AssumeRole', Principal: { Service: 'cloudformation.amazonaws.com' } }],
  });
});

test('shu-9bj.2: the template writes /cdk-bootstrap/<qualifier>/version at a version a shukkaSynthesizer stack accepts', () => {
  const param = resources.CdkBootstrapVersion!.Properties;
  assert.equal(param.Name, '/cdk-bootstrap/trendigle/version');
  assert.equal(param.Value, String(SHUKKA_BOOTSTRAP_VERSION));

  const outdir = mkdtempSync(join(tmpdir(), 'shu-9bj.2-'));
  writeFileSync(join(outdir, 'asset.txt'), 'x');
  const app = new App({ outdir: join(outdir, 'cdk.out') });
  const stack = new Stack(app, 'Trendigle-prod', { synthesizer: shukkaSynthesizer('trendigle'), env: { account: '123456789012', region: 'us-east-1' } });
  new s3assets.Asset(stack, 'File', { path: join(outdir, 'asset.txt') });
  const assembly = app.synth();
  const art = assembly.getStackByName('Trendigle-prod');
  assert.equal(art.bootstrapStackVersionSsmParameter, '/cdk-bootstrap/trendigle/version');
  const required = [art.requiresBootstrapStackVersion ?? 0];
  for (const a of assembly.artifacts) {
    if (a instanceof cxapi.AssetManifestArtifact) {
      required.push(a.requiresBootstrapStackVersion ?? 0);
      assert.equal(a.bootstrapStackVersionSsmParameter, '/cdk-bootstrap/trendigle/version');
    }
  }
  for (const r of required) assert.ok(SHUKKA_BOOTSTRAP_VERSION >= r, `bootstrap version ${SHUKKA_BOOTSTRAP_VERSION} >= required ${r}`);

  // The roles and bucket the synthesizer names are the ones the template creates.
  const resolve = (s: string) => s.replaceAll('${AWS::AccountId}', '123456789012').replaceAll('${AWS::Region}', 'us-east-1').replaceAll('${AWS::Partition}', 'aws');
  const n = bootstrapNames('trendigle');
  assert.equal(resolve(art.assumeRoleArn ?? ''), `arn:aws:iam::123456789012:role/${resolve(n.deployRole)}`);
  assert.equal(resolve(art.cloudFormationExecutionRoleArn ?? ''), `arn:aws:iam::123456789012:role/${resolve(n.executionRole)}`);
  const assetFile = (assembly.artifacts.find((a) => a instanceof cxapi.AssetManifestArtifact) as cxapi.AssetManifestArtifact).contents;
  const dest = Object.values(assetFile.files ?? {}).flatMap((f) => Object.values(f.destinations));
  assert.ok(dest.length > 0);
  for (const d of dest) {
    assert.equal(resolve(d.bucketName), resolve(n.assetBucket));
    assert.equal(resolve(d.assumeRoleArn ?? ''), `arn:aws:iam::123456789012:role/${resolve(n.filePublishingRole)}`);
  }
});

function fakeIam(roles: { RoleName: string; boundary?: string; account?: string }[], pageSize = 2): RoleReader & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async listRoles({ Marker }) {
      calls.push(`list ${Marker ?? ''}`);
      const start = Marker ? Number(Marker) : 0;
      const page = roles.slice(start, start + pageSize).map((r) => ({ RoleName: r.RoleName }));
      const next = start + pageSize;
      return next < roles.length ? { Roles: page, IsTruncated: true, Marker: String(next) } : { Roles: page, IsTruncated: false };
    },
    async getRole({ RoleName }) {
      calls.push(`get ${RoleName}`);
      const r = roles.find((x) => x.RoleName === RoleName)!;
      return {
        Role: {
          RoleName,
          Arn: `arn:aws:iam::${r.account ?? '123456789012'}:role/${RoleName}`,
          ...(r.boundary ? { PermissionsBoundary: { PermissionsBoundaryArn: r.boundary } } : {}),
        },
      };
    },
  };
}

test('shu-9bj.2: the unbounded-role check lists project-prefixed roles that lack the project boundary', async () => {
  const B = 'arn:aws:iam::123456789012:policy/trendigle-shukka-boundary';
  const iam = fakeIam([
    { RoleName: 'trendigle-shukka-infra', boundary: B },
    { RoleName: 'Trendigle-prod-Instance-Role1ABC', boundary: B },
    { RoleName: 'trendigle-prod-github-deploy' }, // predates the fence: no boundary
    { RoleName: 'Trendigle-old-admin', boundary: 'arn:aws:iam::123456789012:policy/orbitary-shukka-boundary' },
    { RoleName: 'trendigle-foreign', boundary: 'arn:aws:iam::210987654321:policy/trendigle-shukka-boundary' },
    { RoleName: 'Orbitary-prod-Role' },
    { RoleName: 'cdk-trendigle-deploy-role-123456789012-us-east-1' },
  ]);
  const got = await unboundedRoles(iam, 'trendigle');
  assert.deepEqual(got, [
    { roleName: 'trendigle-prod-github-deploy', arn: 'arn:aws:iam::123456789012:role/trendigle-prod-github-deploy' },
    { roleName: 'Trendigle-old-admin', arn: 'arn:aws:iam::123456789012:role/Trendigle-old-admin', boundaryArn: 'arn:aws:iam::123456789012:policy/orbitary-shukka-boundary' },
    { roleName: 'trendigle-foreign', arn: 'arn:aws:iam::123456789012:role/trendigle-foreign', boundaryArn: 'arn:aws:iam::210987654321:policy/trendigle-shukka-boundary' },
  ]);
  assert.equal(iam.calls.filter((c) => c.startsWith('list')).length, 4, 'follows every page');
  assert.ok(!iam.calls.includes('get Orbitary-prod-Role'), 'reads only roles in the prefix');
  assert.deepEqual(await unboundedRoles(fakeIam([{ RoleName: 'trendigle-a', boundary: B }]), 'trendigle'), []);
  assert.ok(inProjectPrefix('trendigle', 'trendiglex') && inProjectPrefix('trendigle', 'Trendigle-x') && !inProjectPrefix('trendigle', 'xtrendigle'));
});
