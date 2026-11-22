import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
    // shu-9bj.9: StringNotLike refuses pre-release tags unless allowPrerelease is set.
    assert.deepEqual(Object.keys(st.Condition as Json).sort(), ['StringEquals', 'StringLike', 'StringNotLike'], 'only StringEquals, StringLike and StringNotLike');
    assert.deepEqual(Object.keys((st.Condition as Json).StringEquals as Json).sort(), [AUD, SUB].sort());
  });

  test(`shu-7nw: ${kind} role trust requires job_workflow_ref StringLike ${r.file}@refs/tags/v1 or v1.*`, () => {
    const st = trust(synth().template, r.name);
    const like = (st.Condition as Json).StringLike as Json;
    assert.deepEqual(Object.keys(like), [WF]);
    assert.deepEqual(like[WF], [
      `rummykhan/shukka/.github/workflows/${r.file}@refs/tags/v1`,
      `rummykhan/shukka/.github/workflows/${r.file}@refs/tags/v1.*`,
    ]);
  });

  test(`shu-7nw: ${kind} role trusts the imported provider as its only principal`, () => {
    const st = trust(synth().template, r.name);
    assert.deepEqual(st.Principal as unknown, { Federated: PROVIDER });
  });
}

// IAM StringLike: '*' any run of characters, '?' one character, everything else literal.
function like(pattern: string, value: string): boolean {
  const re = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${re}$`).test(value);
}
const likeAny = (patterns: unknown, value: string) => ([patterns].flat() as string[]).some((p) => like(p, value));
// Whether a trust statement's job_workflow_ref conditions let this ref through (StringLike and not StringNotLike).
const trustsRef = (st: Statement, ref: string) => {
  const cond = st.Condition as Record<string, Json | undefined>;
  return likeAny(cond.StringLike?.[WF], ref) && !(cond.StringNotLike && likeAny(cond.StringNotLike[WF], ref));
};

test('shu-7nw: the default version patterns match v1 and its releases, not v10 or v1foo', () => {
  const { template } = synth();
  for (const r of Object.values(ROLES)) {
    const st = trust(template, r.name);
    const ref = (tag: string) => `rummykhan/shukka/.github/workflows/${r.file}@refs/tags/${tag}`;
    for (const ok of ['v1', 'v1.0.0', 'v1.4.2']) assert.ok(trustsRef(st, ref(ok)), `${r.name} trusts ${ok}`);
    // shu-9bj.9: v1.0.0-rc.3 is refused by default (pre-release).
    for (const no of ['v10', 'v10.0.0', 'v1foo', 'v1-rc', 'v1.0.0-rc.3', 'v2', 'v2.0.0', 'v']) assert.ok(!trustsRef(st, ref(no)), `${r.name} refuses ${no}`);
    const other = r.file === 'infra.yml' ? 'ec2.yml' : 'infra.yml';
    assert.ok(!trustsRef(st, `rummykhan/shukka/.github/workflows/${other}@refs/tags/v1`), `${r.name} refuses ${other}`);
    assert.ok(!trustsRef(st, `rummykhan/shukka/.github/workflows/${r.file}@refs/heads/main`), `${r.name} refuses branches`);
  }
});

test('shu-9bj.9: trust refuses pre-release tags by StringNotLike <workflow>@refs/tags/*-* unless allowPrerelease is set', () => {
  const ref = (file: string, tag: string) => `rummykhan/shukka/.github/workflows/${file}@refs/tags/${tag}`;
  const def = synth().template;
  for (const r of Object.values(ROLES)) {
    const st = trust(def, r.name);
    assert.deepEqual((st.Condition as Json).StringNotLike, { [WF]: `rummykhan/shukka/.github/workflows/${r.file}@refs/tags/*-*` });
    for (const tag of ['v1.0.0-rc.1', 'v1.2.0-beta', 'v1-rc']) assert.ok(!trustsRef(st, ref(r.file, tag)), `${r.name} refuses ${tag} by default`);
    for (const tag of ['v1', 'v1.0.0', 'v1.2.3']) assert.ok(trustsRef(st, ref(r.file, tag)), `${r.name} trusts ${tag}`);
  }
  for (const props of [{ allowPrerelease: false }, {}]) {
    for (const r of Object.values(ROLES)) assert.ok((trust(synth(props).template, r.name).Condition as Json).StringNotLike, 'refused unless opted in');
  }
  const rc = synth({ allowPrerelease: true, allowBranch: 'rc-test' }).template;
  for (const r of Object.values(ROLES)) {
    const st = trust(rc, r.name);
    assert.equal((st.Condition as Json).StringNotLike, undefined, `${r.name}: no StringNotLike with allowPrerelease`);
    assert.ok(trustsRef(st, ref(r.file, 'v1.0.0-rc.1')), `${r.name} trusts v1.0.0-rc.1 with allowPrerelease`);
    assert.ok(trustsRef(st, ref(r.file, 'v1.0.0')));
    assert.ok(!trustsRef(st, ref(r.file, 'v10.0.0-rc.1')), `${r.name} still refuses another release line`);
    assert.ok(trustsRef(st, `rummykhan/shukka/.github/workflows/${r.file}@refs/heads/rc-test`), `${r.name} trusts the allowed branch`);
  }
  // With allowBranch only, the branch ref passes the pre-release refusal (it is not a tag).
  const branch = synth({ allowBranch: 'rc-test' }).template;
  for (const r of Object.values(ROLES)) {
    const st = trust(branch, r.name);
    assert.ok(trustsRef(st, `rummykhan/shukka/.github/workflows/${r.file}@refs/heads/rc-test`));
    assert.ok(!trustsRef(st, ref(r.file, 'v1.0.0-rc.1')));
  }
});

test('shu-7nw: shukkaVersions selects another release line and builds both patterns', () => {
  const { template } = synth({ shukkaVersions: 'v2' });
  for (const r of Object.values(ROLES)) {
    const pats = ((trust(template, r.name).Condition as Json).StringLike as Json)[WF];
    assert.deepEqual(pats, [
      `rummykhan/shukka/.github/workflows/${r.file}@refs/tags/v2`,
      `rummykhan/shukka/.github/workflows/${r.file}@refs/tags/v2.*`,
    ]);
    assert.ok(!likeAny(pats, `rummykhan/shukka/.github/workflows/${r.file}@refs/tags/v1.0.0`));
  }
  const narrow = ((trust(synth({ shukkaVersions: 'v1.2' }).template, 'demo-shukka-infra').Condition as Json).StringLike as Json)[WF];
  assert.ok(likeAny(narrow, 'rummykhan/shukka/.github/workflows/infra.yml@refs/tags/v1.2.3'));
  assert.ok(!likeAny(narrow, 'rummykhan/shukka/.github/workflows/infra.yml@refs/tags/v1.20.0'));
});

test('shu-7nw: allowBranch is off by default and, when set, adds exactly one branch ref', () => {
  const { template } = synth({ allowBranch: 'rc-test' });
  for (const r of Object.values(ROLES)) {
    const like = (trust(template, r.name).Condition as Json).StringLike as Json;
    assert.deepEqual(like[WF], [
      `rummykhan/shukka/.github/workflows/${r.file}@refs/tags/v1`,
      `rummykhan/shukka/.github/workflows/${r.file}@refs/tags/v1.*`,
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
    for (const p of (cond.StringLike as Record<string, string[]>)[WF] as string[]) {
      assert.ok(p.indexOf('*') === -1 || p.indexOf('*') === p.length - 1, `${p}: only a trailing wildcard`);
      assert.ok(!p.includes('?'), `${p}: no ? wildcard`);
    }
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
  for (const bad of ['*', '*v1', '?1', 'v1*', 'v1.*', 'v1?', 'v1/../x', 'v 1', '', '1', 'v1.', 'v1.0.0-rc.*']) {
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
      ],
    },
  ]));
});

test('shu-7nw: no infra role statement names the lookup role', () => {
  for (const props of [{}, { project: 'my-proj', qualifier: 'myproj' }]) {
    const { template } = synth(props);
    const name = `${(props as { project?: string }).project ?? 'demo'}-shukka-infra`;
    const json = JSON.stringify(flat(permissions(template, name)));
    assert.ok(!/lookup/i.test(json), `${name} statements must not name lookup: ${json}`);
    for (const st of normalise(permissions(template, name))) {
      for (const res of st.Resource as string[]) assert.ok(!like(res, `arn:aws:iam::${ACCOUNT}:role/cdk-demo-lookup-role-${ACCOUNT}-${REGION}`) && !like(res, `arn:aws:iam::${ACCOUNT}:role/cdk-myproj-lookup-role-${ACCOUNT}-${REGION}`), `${res} reaches a lookup role`);
    }
  }
});

test('shu-7nw: infra role uses the qualifier when it differs from the project', () => {
  const { template } = synth({ project: 'my-proj', qualifier: 'myproj' });
  const [st] = normalise(permissions(template, 'my-proj-shukka-infra'));
  assert.deepEqual(st?.Resource, [
    `arn:aws:iam::${ACCOUNT}:role/cdk-myproj-deploy-role-*`,
    `arn:aws:iam::${ACCOUNT}:role/cdk-myproj-file-publishing-role-*`,
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
    { Effect: 'Allow', Action: 'ssm:DescribeInstanceInformation', Resource: '*' },
  ]));
});

test('shu-7nw: app role follows instanceTag', () => {
  const { template } = synth({ instanceTag: { key: 'Stack', value: 'demo-box' } });
  const json = JSON.stringify(flat(permissions(template, 'demo-shukka-app')));
  assert.ok(json.includes('"ssm:resourceTag/Stack":"demo-box"'));
});

test('shu-9bj.9: the app role has no ssm:GetParameter (nothing it runs reads the project parameters)', () => {
  const { template } = synth();
  const statements = normalise(permissions(template, 'demo-shukka-app'));
  assert.ok(!statements.some((st) => (st.Action as string[]).some((a) => a.startsWith('ssm:GetParameter'))), JSON.stringify(statements));
  assert.ok(!JSON.stringify(statements).includes(':parameter/'), 'no parameter resource');
  // The prop that chose the path is gone with the grant.
  assert.ok(!readFileSync(new URL('../lib/access.ts', import.meta.url), 'utf8').includes('ssmPath'));
});

test('shu-9bj.9: import { ShukkaAccess } from \'shukka\' works under tsx in a consumer', () => {
  // A consumer's node_modules as a GitHub dependency installs it: a copy of the package (not a link into this
  // checkout), next to the consumer's own aws-cdk-lib and constructs.
  const root = fileURLToPath(new URL('..', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'shukka-consumer-'));
  try {
    const mods = join(dir, 'node_modules');
    mkdirSync(join(mods, 'shukka'), { recursive: true });
    cpSync(join(root, 'package.json'), join(mods, 'shukka', 'package.json'));
    cpSync(join(root, 'lib'), join(mods, 'shukka', 'lib'), { recursive: true });
    for (const dep of ['aws-cdk-lib', 'constructs']) symlinkSync(join(root, 'node_modules', dep), join(mods, dep), 'dir');
    cpSync(join(root, 'test', 'fixtures', 'consumer', 'app.mjs'), join(dir, 'app.mjs'));
    const tsx = import.meta.resolve('tsx');
    const r = spawnSync(process.execPath, ['--import', tsx, 'app.mjs'], { cwd: dir, encoding: 'utf8', timeout: 120_000 });
    assert.equal(r.status, 0, `consumer failed:\n${r.stderr}`);
    assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').pop() as string), {
      roles: ['consumer-shukka-app', 'consumer-shukka-diff', 'consumer-shukka-infra'],
      boundary: 'function',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shu-7nw: diff role may only read templates and stacks of the project and the bootstrap version', () => {
  const { template } = synth();
  assert.deepEqual(normalise(permissions(template, 'demo-shukka-diff')), normalise([
    {
      Effect: 'Allow',
      Action: ['cloudformation:DescribeStacks', 'cloudformation:GetTemplate'],
      Resource: [
        `arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/demo-*/*`,
        `arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/Demo-*/*`,
      ],
    },
    { Effect: 'Allow', Action: 'ssm:GetParameter', Resource: `arn:aws:ssm:${REGION}:${ACCOUNT}:parameter/cdk-bootstrap/demo/version` },
  ]));
  const json = JSON.stringify(template.toJSON());
  assert.ok(!/lookup-role/.test(JSON.stringify(permissions(template, 'demo-shukka-diff'))), 'diff role never reaches the lookup role');
  assert.ok(json.includes('demo-shukka-diff'));
});

test('shu-7nw: diff role stack resources do not reach a project whose name starts with this one', () => {
  const { template } = synth();
  const resources = normalise(permissions(template, 'demo-shukka-diff')).flatMap((s) =>
    (s.Action as string[]).includes('cloudformation:GetTemplate') ? (s.Resource as string[]) : [],
  );
  const stack = (name: string) => `arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/${name}/0a1b2c3d-1111-2222-3333-444455556666`;
  for (const ok of ['Demo-prod-Dns', 'Demo-prod-Box', 'demo-ci']) assert.ok(likeAny(resources, stack(ok)), `reads ${ok}`);
  for (const no of ['Demopro-prod-Dns', 'demopro-ci', 'DemoX', 'Demo', 'CDKToolkit', 'CDKToolkit-demo', 'Other-prod-Dns']) {
    assert.ok(!likeAny(resources, stack(no)), `refuses ${no}`);
  }
});

test('shu-7nw: no permission statement has a wildcard action or Resource * except actions without a resource type', () => {
  const { template } = synth();
  for (const r of Object.values(ROLES)) {
    for (const st of normalise(permissions(template, r.name))) {
      for (const a of st.Action as string[]) assert.ok(!a.includes('*'), `${r.name}: action ${a}`);
      if ((st.Resource as unknown[]).includes('*')) {
        assert.ok([JSON.stringify(['ec2:DescribeInstances', 'ssm:GetCommandInvocation']), JSON.stringify(['ssm:DescribeInstanceInformation'])].includes(JSON.stringify(st.Action)), `${r.name}: Resource * only for these`);
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
