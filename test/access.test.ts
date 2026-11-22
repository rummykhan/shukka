import { test } from 'node:test';
import assert from 'node:assert/strict';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { ShukkaAccess, type ShukkaAccessProps } from '../lib/index.js';

const ACCOUNT = '123456789012';
const REGION = 'us-east-1';
const REPO = 'example@1001/consumer@2002';
const PROVIDER = `arn:aws:iam::${ACCOUNT}:oidc-provider/token.actions.githubusercontent.com`;

type Json = Record<string, unknown>;
type Statement = { Effect: string; Action: string | string[]; Resource?: unknown; Principal?: unknown; Condition?: Json; Sid?: string };

function synth(overrides: Partial<ShukkaAccessProps> = {}): { template: Template; stack: Stack } {
  const app = new App();
  const stack = new Stack(app, 'Ci', { env: { account: ACCOUNT, region: REGION } });
  const deployBucket = s3.Bucket.fromBucketName(stack, 'Bucket', 'demo-prod-deploy');
  new ShukkaAccess(stack, 'Access', {
    project: 'demo',
    githubRepo: REPO,
    oidcProviderArn: PROVIDER,
    deployBucket,
    ...overrides,
  });
  return { template: Template.fromStack(stack), stack };
}

function role(template: Template, name: string): { logicalId: string; props: Json } {
  const roles = template.findResources('AWS::IAM::Role', { Properties: { RoleName: name } });
  const ids = Object.keys(roles);
  assert.equal(ids.length, 1, `exactly one role named ${name}`);
  const id = ids[0] as string;
  return { logicalId: id, props: (roles[id] as { Properties: Json }).Properties };
}

function trust(template: Template, name: string): Statement {
  const doc = role(template, name).props.AssumeRolePolicyDocument as { Statement: Statement[] };
  assert.equal(doc.Statement.length, 1, 'one trust statement');
  return doc.Statement[0] as Statement;
}

// Every permission statement attached to the role: inline policies, separate policies, managed policies.
function permissions(template: Template, name: string): Statement[] {
  const { logicalId, props } = role(template, name);
  assert.equal(props.ManagedPolicyArns, undefined, `${name} has no managed policies`);
  const inline = ((props.Policies as { PolicyDocument: { Statement: Statement[] } }[] | undefined) ?? []).flatMap(
    (p) => p.PolicyDocument.Statement,
  );
  const policies = Object.values(template.findResources('AWS::IAM::Policy')).filter((p) =>
    JSON.stringify((p as { Properties: Json }).Properties.Roles).includes(`"${logicalId}"`),
  );
  const separate = policies.flatMap(
    (p) => (p as { Properties: { PolicyDocument: { Statement: Statement[] } } }).Properties.PolicyDocument.Statement,
  );
  const managed = Object.values(template.findResources('AWS::IAM::ManagedPolicy')).filter((p) =>
    JSON.stringify((p as { Properties: Json }).Properties.Roles ?? []).includes(`"${logicalId}"`),
  );
  assert.equal(managed.length, 0, `${name} has no customer managed policies`);
  return [...inline, ...separate].map((s) => { const copy = { ...s }; delete copy.Sid; return copy; });
}

// Resolve CloudFormation joins of literal strings into plain strings so resources can be compared.
function flat(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(flat);
  if (value && typeof value === 'object') {
    const obj = value as Json;
    if ('Fn::Join' in obj) {
      const [sep, parts] = obj['Fn::Join'] as [string, unknown[]];
      return parts.map((p) => flat(p)).join(sep);
    }
    if ('Ref' in obj && obj.Ref === 'AWS::Partition') return 'aws';
    if ('Ref' in obj && obj.Ref === 'AWS::Region') return REGION;
    if ('Ref' in obj && obj.Ref === 'AWS::AccountId') return ACCOUNT;
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, flat(v)]));
  }
  return value;
}

function normalise(statements: Statement[]): Statement[] {
  const list = (v: unknown) => (Array.isArray(v) ? [...(v as string[])].sort() : [v]);
  return (flat(statements) as Statement[])
    .map((s) => ({ ...s, Action: list(s.Action) as string[], Resource: list(s.Resource) }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

const SUB = 'token.actions.githubusercontent.com:sub';
const AUD = 'token.actions.githubusercontent.com:aud';
const WF = 'token.actions.githubusercontent.com:job_workflow_ref';
const ROLES = {
  infra: { name: 'demo-shukka-infra', sub: `repo:${REPO}:ref:refs/heads/main`, file: 'infra.yml' },
  app: { name: 'demo-shukka-app', sub: `repo:${REPO}:ref:refs/heads/main`, file: 'ec2.yml' },
  diff: { name: 'demo-shukka-diff', sub: `repo:${REPO}:pull_request`, file: 'infra.yml' },
} as const;

for (const [kind, r] of Object.entries(ROLES)) {
  test(`shu-7nw: ${kind} role trust requires aud sts.amazonaws.com`, () => {
    const st = trust(synth().template, r.name);
    assert.equal(st.Effect, 'Allow');
    assert.equal(st.Action, 'sts:AssumeRoleWithWebIdentity');
    assert.deepEqual((st.Condition as Json).StringEquals && ((st.Condition as Json).StringEquals as Json)[AUD], 'sts.amazonaws.com');
  });

  test(`shu-7nw: ${kind} role trust requires sub StringEquals ${r.sub.replace(REPO, '<repo>')}`, () => {
    const st = trust(synth().template, r.name);
    assert.equal(((st.Condition as Json).StringEquals as Json)[SUB], r.sub);
    assert.equal(Object.keys(st.Condition as Json).length, 2, 'only StringEquals and StringLike');
    assert.deepEqual(Object.keys((st.Condition as Json).StringEquals as Json).sort(), [AUD, SUB].sort());
  });

  test(`shu-7nw: ${kind} role trust requires job_workflow_ref StringLike ${r.file}@refs/tags/v1*`, () => {
    const st = trust(synth().template, r.name);
    const like = (st.Condition as Json).StringLike as Json;
    assert.deepEqual(Object.keys(like), [WF]);
    assert.equal(like[WF], `rummykhan/shukka/.github/workflows/${r.file}@refs/tags/v1*`);
  });

  test(`shu-7nw: ${kind} role trusts the imported provider as its only principal`, () => {
    const st = trust(synth().template, r.name);
    assert.deepEqual(st.Principal as unknown, { Federated: PROVIDER });
  });
}

test('shu-7nw: shukkaVersions narrows the job_workflow_ref tag pattern', () => {
  const { template } = synth({ shukkaVersions: 'v1.2*' });
  for (const r of Object.values(ROLES)) {
    const like = (trust(template, r.name).Condition as Json).StringLike as Json;
    assert.equal(like[WF], `rummykhan/shukka/.github/workflows/${r.file}@refs/tags/v1.2*`);
  }
});

test('shu-7nw: allowBranch is off by default and, when set, adds exactly one branch ref', () => {
  const { template } = synth({ allowBranch: 'rc-test' });
  for (const r of Object.values(ROLES)) {
    const like = (trust(template, r.name).Condition as Json).StringLike as Json;
    assert.deepEqual(like[WF], [
      `rummykhan/shukka/.github/workflows/${r.file}@refs/tags/v1*`,
      `rummykhan/shukka/.github/workflows/${r.file}@refs/heads/rc-test`,
    ]);
  }
  const json = JSON.stringify(synth().template.toJSON());
  assert.ok(!json.includes('refs/heads/rc'), 'no branch ref without allowBranch');
  assert.ok(!json.includes('@refs/heads/'), 'job_workflow_ref never names a branch by default');
});

test('shu-7nw: no trust pattern starts with * or contains a wildcard outside the version suffix', () => {
  const { template } = synth();
  for (const r of Object.values(ROLES)) {
    const cond = trust(template, r.name).Condition as Record<string, Record<string, string | string[]>>;
    for (const op of Object.values(cond)) {
      for (const v of Object.values(op).flat()) {
        assert.ok(!v.startsWith('*'), `${v} must not start with *`);
        assert.ok(!v.startsWith('?'), `${v} must not start with ?`);
      }
    }
    const like = cond.StringLike as Record<string, string>;
    assert.equal((like[WF] as string).indexOf('*'), (like[WF] as string).length - 1);
  }
});

test('shu-7nw: githubRepo accepts owner/repo and the immutable owner@id/repo@id', () => {
  synth({ githubRepo: 'org/repo' });
  synth({ githubRepo: 'my-org/my.repo_name' });
  synth({ githubRepo: 'trendigle@220634492/trendigle@1462395046' });
});

test('shu-7nw: githubRepo is refused when malformed or wildcarded', () => {
  for (const bad of [
    '*',
    '*/repo',
    'org/*',
    'org/re*po',
    'org/re?po',
    'org',
    'org/repo/extra',
    'repo:org/repo',
    'org/repo:ref:refs/heads/main',
    'org@/repo@1',
    'org@1/repo',
    'org@abc/repo@1',
    '-org/repo',
    'org/..',
    '',
    ' org/repo',
  ]) {
    assert.throws(() => synth({ githubRepo: bad }), /githubRepo/, `refused: ${JSON.stringify(bad)}`);
  }
});

test('shu-7nw: shukkaVersions, allowBranch and project are validated', () => {
  for (const bad of ['*', '*v1', '?1', 'v1/../x', 'v 1', '']) {
    assert.throws(() => synth({ shukkaVersions: bad }), /shukkaVersions/, `refused: ${JSON.stringify(bad)}`);
  }
  for (const bad of ['*', 'rc-*', 'rc?', '', 'a b', '-rc']) {
    assert.throws(() => synth({ allowBranch: bad }), /allowBranch/, `refused: ${JSON.stringify(bad)}`);
  }
  for (const bad of ['Demo', '1demo', 'd', 'demo*', 'demo_x']) {
    assert.throws(() => synth({ project: bad }), /project/, `refused: ${JSON.stringify(bad)}`);
  }
});

test('shu-7nw: infra role may only sts:AssumeRole the project-qualifier bootstrap roles', () => {
  const { template } = synth();
  assert.deepEqual(normalise(permissions(template, 'demo-shukka-infra')), normalise([
    {
      Effect: 'Allow',
      Action: 'sts:AssumeRole',
      Resource: [
        `arn:aws:iam::${ACCOUNT}:role/cdk-demo-deploy-role-*`,
        `arn:aws:iam::${ACCOUNT}:role/cdk-demo-file-publishing-role-*`,
        `arn:aws:iam::${ACCOUNT}:role/cdk-demo-lookup-role-*`,
      ],
    },
  ]));
});

test('shu-7nw: infra role uses the qualifier when it differs from the project', () => {
  const { template } = synth({ project: 'my-proj', qualifier: 'myproj' });
  const [st] = normalise(permissions(template, 'my-proj-shukka-infra'));
  assert.deepEqual(st?.Resource, [
    `arn:aws:iam::${ACCOUNT}:role/cdk-myproj-deploy-role-*`,
    `arn:aws:iam::${ACCOUNT}:role/cdk-myproj-file-publishing-role-*`,
    `arn:aws:iam::${ACCOUNT}:role/cdk-myproj-lookup-role-*`,
  ]);
  assert.throws(() => synth({ project: 'my-proj' }), /qualifier/, 'a project name that is not a valid qualifier needs one');
  assert.throws(() => synth({ qualifier: 'Bad-Q' }), /qualifier/);
});

test('shu-7nw: app role has exactly the permissions in the design', () => {
  const { template } = synth();
  assert.deepEqual(normalise(permissions(template, 'demo-shukka-app')), normalise([
    { Effect: 'Allow', Action: 's3:PutObject', Resource: 'arn:aws:s3:::demo-prod-deploy/demo/*' },
    { Effect: 'Allow', Action: 'ssm:SendCommand', Resource: `arn:aws:ssm:${REGION}::document/AWS-RunShellScript` },
    {
      Effect: 'Allow',
      Action: 'ssm:SendCommand',
      Resource: `arn:aws:ec2:${REGION}:${ACCOUNT}:instance/*`,
      Condition: { StringEquals: { 'ssm:resourceTag/Project': 'demo' } },
    },
    { Effect: 'Allow', Action: ['ec2:DescribeInstances', 'ssm:GetCommandInvocation'], Resource: '*' },
    { Effect: 'Allow', Action: 'ssm:GetParameter', Resource: `arn:aws:ssm:${REGION}:${ACCOUNT}:parameter/demo/prod/*` },
  ]));
});

test('shu-7nw: app role follows instanceTag and ssmPath', () => {
  const { template } = synth({ instanceTag: { key: 'Stack', value: 'demo-box' }, ssmPath: '/demo/live' });
  const json = JSON.stringify(flat(permissions(template, 'demo-shukka-app')));
  assert.ok(json.includes('"ssm:resourceTag/Stack":"demo-box"'));
  assert.ok(json.includes(`parameter/demo/live/*`));
  assert.ok(!json.includes('parameter/demo/prod'));
  assert.throws(() => synth({ ssmPath: 'demo/prod' }), /ssmPath/);
  assert.throws(() => synth({ ssmPath: '/' }), /ssmPath/);
  assert.throws(() => synth({ ssmPath: '/demo/*' }), /ssmPath/);
});

test('shu-7nw: diff role may only read templates and stacks of the project and the bootstrap version', () => {
  const { template } = synth();
  assert.deepEqual(normalise(permissions(template, 'demo-shukka-diff')), normalise([
    {
      Effect: 'Allow',
      Action: ['cloudformation:DescribeStacks', 'cloudformation:GetTemplate'],
      Resource: [
        `arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/demo*/*`,
        `arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/Demo*/*`,
      ],
    },
    { Effect: 'Allow', Action: 'ssm:GetParameter', Resource: `arn:aws:ssm:${REGION}:${ACCOUNT}:parameter/cdk-bootstrap/demo/version` },
  ]));
  const json = JSON.stringify(template.toJSON());
  assert.ok(!/lookup-role/.test(JSON.stringify(permissions(template, 'demo-shukka-diff'))), 'diff role never reaches the lookup role');
  assert.ok(json.includes('demo-shukka-diff'));
});

test('shu-7nw: no permission statement has a wildcard action or Resource * except actions without a resource type', () => {
  const { template } = synth();
  for (const r of Object.values(ROLES)) {
    for (const st of normalise(permissions(template, r.name))) {
      for (const a of st.Action as string[]) assert.ok(!a.includes('*'), `${r.name}: action ${a}`);
      if ((st.Resource as unknown[]).includes('*')) {
        assert.deepEqual(st.Action, ['ec2:DescribeInstances', 'ssm:GetCommandInvocation'], `${r.name}: Resource * only for these`);
      }
    }
  }
});

test('shu-7nw: the OIDC provider is imported by ARN, never created', () => {
  const { template } = synth();
  template.resourceCountIs('AWS::IAM::OIDCProvider', 0);
  template.resourceCountIs('Custom::AWSCDKOpenIdConnectProvider', 0);
  assert.equal(Object.keys(template.findResources('AWS::Lambda::Function')).length, 0, 'no provider custom resource');
  template.resourceCountIs('AWS::IAM::Role', 3);
});

test('shu-7nw: the OIDC provider defaults to the account provider ARN the account stack creates', () => {
  const { template } = synth({ oidcProviderArn: undefined });
  template.resourceCountIs('AWS::IAM::OIDCProvider', 0);
  template.resourceCountIs('Custom::AWSCDKOpenIdConnectProvider', 0);
  const principal = flat(trust(template, 'demo-shukka-infra').Principal);
  assert.deepEqual(principal, { Federated: PROVIDER });
});

test('shu-7nw: a malformed oidcProviderArn is refused', () => {
  for (const bad of [
    'arn:aws:iam::123456789012:oidc-provider/accounts.google.com',
    'arn:aws:iam::123456789012:role/x',
    'token.actions.githubusercontent.com',
  ]) {
    assert.throws(() => synth({ oidcProviderArn: bad }), /oidcProviderArn/, bad);
  }
});

test('shu-7nw: exposes the three roles', () => {
  const app = new App();
  const stack = new Stack(app, 'Ci', { env: { account: ACCOUNT, region: REGION } });
  const access = new ShukkaAccess(stack, 'Access', {
    project: 'demo',
    githubRepo: REPO,
    deployBucket: s3.Bucket.fromBucketName(stack, 'Bucket', 'demo-prod-deploy'),
  });
  assert.ok(access.infraRole.roleArn);
  assert.ok(access.appRole.roleArn);
  assert.ok(access.diffRole.roleArn);
});
