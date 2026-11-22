// shu-9bj.6: scripts/policy-guard.mjs stops an assembly whose trust or resource policies let a principal outside the
// project in; the deploy and PR diff jobs run it after assembly.mjs and before any role is assumed; executionC denies
// changes to the pipeline's own roles.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { App, Duration, NestedStack, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { ShukkaAccess } from '../lib/access.js';
import { applyBoundary, fenceDocuments } from '../lib/boundary.js';
import { shukkaSynthesizer } from '../lib/synthesizer.js';
import { checkPolicies, githubRepoFromUrl, policyGuard, summary } from '../scripts/policy-guard.mjs';
import { checkAssembly } from '../scripts/assembly.mjs';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, 'scripts', 'policy-guard.mjs');
const ACCOUNT = '818221194501';
const OUTSIDER = '999999999999';
const REPO = 'trendigle/trendigle';
const PROVIDER = `arn:aws:iam::${ACCOUNT}:oidc-provider/token.actions.githubusercontent.com`;
const scratch = mkdtempSync(join(tmpdir(), 'shu-9bj.6-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;

/** A cloud assembly with one stack per template (Name -> template). */
function assembly(templates: Record<string, Loose>, extra: Loose = {}): string {
  const dir = join(scratch, `asm-${++n}`);
  mkdirSync(dir, { recursive: true });
  const artifacts: Loose = { ...extra };
  for (const [name, template] of Object.entries(templates)) {
    writeFileSync(join(dir, `${name}.template.json`), JSON.stringify(template));
    artifacts[name] = { type: 'aws:cloudformation:stack', environment: `aws://${ACCOUNT}/us-east-1`, properties: { templateFile: `${name}.template.json` } };
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version: '48.0.0', artifacts }));
  return dir;
}

const role = (principal: Loose | string, condition?: Loose, name = 'trendigle-backdoor'): Loose => ({
  Type: 'AWS::IAM::Role',
  Properties: {
    RoleName: name,
    PermissionsBoundary: `arn:aws:iam::${ACCOUNT}:policy/trendigle-shukka-boundary`,
    AssumeRolePolicyDocument: {
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Action: 'sts:AssumeRole', Principal: principal, ...(condition ? { Condition: condition } : {}) }],
    },
  },
});
const one = (resources: Loose): Loose => ({ Resources: resources });

/** ShukkaAccess's trust conditions, with the parts a test changes. */
const shukkaConditions = (over: Loose = {}): Loose => ({
  StringEquals: {
    'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
    'token.actions.githubusercontent.com:sub': `repo:${REPO}:ref:refs/heads/main`,
  },
  StringLike: {
    'token.actions.githubusercontent.com:job_workflow_ref': [
      'rummykhan/shukka/.github/workflows/infra.yml@refs/tags/v1',
      'rummykhan/shukka/.github/workflows/infra.yml@refs/tags/v1.*',
    ],
  },
  ...over,
});

const check = (dir: string, repos: string[] = [REPO]) => policyGuard(dir, { account: ACCOUNT, repos });

function run(args: string[]) {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

// ---------------------------------------------------------------------------------------------------------------
// The bug, reproduced: a role trusting an outside account.
// ---------------------------------------------------------------------------------------------------------------

test('shu-9bj.6: a role named trendigle-backdoor trusting an outside account stops, exit 1, naming the role and the account', () => {
  const dir = assembly({ 'Trendigle-prod-Ci': one({ Backdoor: role({ AWS: `arn:aws:iam::${OUTSIDER}:root` }) }) });
  const r = run([dir, '--account', ACCOUNT, '--repo', REPO]);
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.out, /^policy-guard: Trendigle-prod-Ci\.template\.json: Backdoor \(AWS::IAM::Role\): trusts AWS arn:aws:iam::999999999999:root, which is not a role of account 818221194501$/m);
  assert.match(r.out, /^policy-guard: stopping\. If this is intended, run the workflow by hand on main with allow_replacement ticked\.$/m);
});

test('shu-9bj.6: --allow (a run by hand with allow_replacement) lets it through with exit 0 and says so; an unreadable assembly is never allowed', () => {
  const dir = assembly({ Ci: one({ Backdoor: role({ AWS: OUTSIDER }) }) });
  const r = run([dir, '--account', ACCOUNT, '--repo', REPO, '--allow']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /trusts AWS 999999999999/);
  assert.match(r.out, /^policy-guard: allowed by the person who started this run \(--allow\)$/m);
  const missing = run([join(scratch, 'no-such-assembly'), '--account', ACCOUNT, '--allow']);
  assert.equal(missing.code, 1);
  assert.match(missing.out, /cannot read .*manifest\.json/);
});

test('shu-9bj.6: --summary appends a ### Trust and resource policies section; bad arguments exit 2', () => {
  const dir = assembly({ Ci: one({ Backdoor: role({ AWS: OUTSIDER }) }) });
  const file = join(scratch, `summary-${++n}.md`);
  writeFileSync(file, '### Guard\n\n');
  assert.equal(run([dir, '--account', ACCOUNT, '--summary', file]).code, 1);
  const text = readFileSync(file, 'utf8');
  assert.match(text, /^### Guard\n\n### Trust and resource policies\n\n\*\*Stopped:\*\* /);
  assert.match(text, /```\npolicy-guard: Ci\.template\.json: Backdoor/);
  assert.match(summary(check(assembly({ Ok: one({ R: role({ Service: 'lambda.amazonaws.com' }) }) }))), /^### Trust and resource policies\n\nNo trust or resource policy lets a principal outside the project in\.\n/);
  for (const args of [[dir], [dir, '--account', '12345'], ['--account', ACCOUNT], [dir, '--account', ACCOUNT, '--repo', 'not a repo'], [dir, '--account', ACCOUNT, '--what']]) {
    const r = run(args);
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.err}`);
    assert.match(r.err, /^policy-guard: .*\nusage: /);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Trust policies: one fixture per kind of principal.
// ---------------------------------------------------------------------------------------------------------------

const trustCases: Array<[string, Loose, RegExp | null]> = [
  ['"*" stops', role('*'), /trusts "\*" \(anyone\)/],
  ['AWS "*" stops', role({ AWS: '*' }), /trusts "\*" \(anyone\)/],
  ['another account by id stops', role({ AWS: OUTSIDER }), /trusts AWS 999999999999, which is not a role of account/],
  ['a role of another account stops', role({ AWS: `arn:aws:iam::${OUTSIDER}:role/x` }), /trusts AWS arn:aws:iam::999999999999:role\/x/],
  ['a user of the account stops', role({ AWS: `arn:aws:iam::${ACCOUNT}:user/someone` }), /not a role of account/],
  ['the account root stops (every principal in the shared account)', role({ AWS: `arn:aws:iam::${ACCOUNT}:root` }), /trusts the whole account 818221194501/],
  ['the account root built with Fn::Join stops', role({ AWS: { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':iam::', { Ref: 'AWS::AccountId' }, ':root']] } }), /trusts the whole account/],
  ['a SAML provider stops', role({ Federated: `arn:aws:iam::${ACCOUNT}:saml-provider/x` }), /trusts Federated arn:aws:iam::818221194501:saml-provider\/x/],
  ['Cognito stops', role({ Federated: 'cognito-identity.amazonaws.com' }), /trusts Federated cognito-identity/],
  ['a canonical user stops', role({ CanonicalUser: 'abc' }), /trusts CanonicalUser abc/],
  ['another account\'s GitHub provider stops', role({ Federated: PROVIDER.replace(ACCOUNT, OUTSIDER) }, shukkaConditions()), /trusts Federated arn:aws:iam::999999999999:oidc-provider/],
  ['the GitHub provider without conditions stops', role({ Federated: PROVIDER }), /without shukka's pinned conditions: no conditions/],
  ['the GitHub provider without job_workflow_ref stops (the old Trendigle shape)', role({ Federated: PROVIDER }, { StringEquals: shukkaConditions().StringEquals }), /no StringLike token\.actions\.githubusercontent\.com:job_workflow_ref/],
  ['the GitHub provider for another repository stops', role({ Federated: PROVIDER }, shukkaConditions({ StringEquals: { ...shukkaConditions().StringEquals, 'token.actions.githubusercontent.com:sub': 'repo:attacker/repo:ref:refs/heads/main' } })), /names another repository than the project's \(trendigle\/trendigle\)/],
  ['a wildcard sub in StringLike stops', role({ Federated: PROVIDER }, { StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' }, StringLike: { ...shukkaConditions().StringLike, 'token.actions.githubusercontent.com:sub': 'repo:trendigle/*' } }), /condition StringLike token\.actions\.githubusercontent\.com:sub is not part of shukka's trust/],
  ['a wildcard in a StringEquals sub stops', role({ Federated: PROVIDER }, shukkaConditions({ StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com', 'token.actions.githubusercontent.com:sub': `repo:${REPO}:*` } })), /is not repo:<owner>\/<repo>:<literal>/],
  ['another workflow than shukka\'s stops', role({ Federated: PROVIDER }, shukkaConditions({ StringLike: { 'token.actions.githubusercontent.com:job_workflow_ref': 'attacker/shukka/.github/workflows/infra.yml@refs/heads/main' } })), /is not one of rummykhan\/shukka's workflows/],
  ['another audience stops', role({ Federated: PROVIDER }, shukkaConditions({ StringEquals: { 'token.actions.githubusercontent.com:aud': 'other', 'token.actions.githubusercontent.com:sub': `repo:${REPO}:pull_request` } })), /aud must be sts\.amazonaws\.com, got other/],
  ['an extra condition operator stops', role({ Federated: PROVIDER }, shukkaConditions({ ForAnyValue: { x: 'y' } })), /condition operator ForAnyValue is not part of shukka's trust/],
  ['NotPrincipal stops', { Type: 'AWS::IAM::Role', Properties: { AssumeRolePolicyDocument: { Statement: [{ Effect: 'Allow', Action: 'sts:AssumeRole', NotPrincipal: { AWS: `arn:aws:iam::${ACCOUNT}:role/x` } }] } } }, /trusts everyone but .* \(NotPrincipal\)/],
  ['a principal from a parameter stops (it cannot be checked)', role({ AWS: { Ref: 'TrustedArn' } }), /trusts AWS <Ref TrustedArn>/],
  ['an Fn::If with one outside branch stops', role({ AWS: { 'Fn::If': ['C', `arn:aws:iam::${ACCOUNT}:role/x`, `arn:aws:iam::${OUTSIDER}:role/x`] } }), /999999999999:role\/x/],
  ['a Service principal passes', role({ Service: ['lambda.amazonaws.com', 'ec2.amazonaws.com'] }), null],
  ['a role of the account passes', role({ AWS: `arn:aws:iam::${ACCOUNT}:role/trendigle-worker` }), null],
  ['a role of the account built with Fn::Sub passes', role({ AWS: { 'Fn::Sub': 'arn:${AWS::Partition}:iam::${AWS::AccountId}:role/trendigle-worker' } }), null],
  ['ShukkaAccess\'s exact shape passes', role({ Federated: PROVIDER }, shukkaConditions()), null],
  ['ShukkaAccess\'s shape with StringNotLike pre-release passes', role({ Federated: PROVIDER }, shukkaConditions({ StringNotLike: { 'token.actions.githubusercontent.com:job_workflow_ref': 'rummykhan/shukka/.github/workflows/infra.yml@refs/tags/v1*-*' } })), null],
  ['ShukkaAccess\'s shape with the immutable repository subject passes', role({ Federated: PROVIDER }, shukkaConditions({ StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com', 'token.actions.githubusercontent.com:sub': 'repo:trendigle@220634492/trendigle@1462395046:ref:refs/heads/main' } })), null],
  ['a Deny statement naming "*" passes', { Type: 'AWS::IAM::Role', Properties: { AssumeRolePolicyDocument: { Statement: [{ Effect: 'Allow', Action: 'sts:AssumeRole', Principal: { Service: 'lambda.amazonaws.com' } }, { Effect: 'Deny', Action: 'sts:AssumeRole', Principal: '*' }] } } }, null],
];

for (const [name, resource, expected] of trustCases) {
  test(`shu-9bj.6: trust policy: ${name}`, () => {
    const r = check(assembly({ Stack: one({ R: resource }) }));
    if (expected === null) {
      assert.deepEqual(r.found, []);
      assert.equal(r.code, 0);
    } else {
      assert.equal(r.code, 1, 'stops');
      assert.ok(r.found.some((line) => /^policy-guard: Stack\.template\.json: R \(AWS::IAM::Role\): /.test(line) && expected.test(line)), r.found.join('\n'));
    }
  });
}

test('shu-9bj.6: re-trusting the pipeline\'s own role (trendigle-shukka-infra) to an outside account stops', () => {
  const r = check(assembly({ Ci: one({ Infra: role({ AWS: `arn:aws:iam::${OUTSIDER}:root` }, undefined, 'trendigle-shukka-infra') }) }));
  assert.equal(r.code, 1);
  assert.match(r.found.join('\n'), /Infra \(AWS::IAM::Role\): trusts AWS arn:aws:iam::999999999999:root/);
});

test('shu-9bj.6: without --repo no GitHub trust passes, since its subject cannot be checked', () => {
  const r = check(assembly({ Ci: one({ R: role({ Federated: PROVIDER }, shukkaConditions()) }) }), []);
  assert.equal(r.code, 1);
  assert.match(r.found.join('\n'), /the project's repository was not given \(--repo\)/);
});

test('shu-9bj.6: a role ARN from another template\'s export passes; an import that is not exported in the assembly stops', () => {
  const exporter = one({ Worker: role({ Service: 'ec2.amazonaws.com' }) });
  exporter.Outputs = { WorkerArn: { Value: { 'Fn::GetAtt': ['Worker', 'Arn'] }, Export: { Name: 'Trendigle-prod-Data:WorkerArn' } } };
  const ok = check(assembly({ Data: exporter, Ci: one({ R: role({ AWS: { 'Fn::ImportValue': 'Trendigle-prod-Data:WorkerArn' } }) }) }));
  assert.deepEqual(ok.found, []);
  const missing = check(assembly({ Ci: one({ R: role({ AWS: { 'Fn::ImportValue': 'Elsewhere:Arn' } }) }) }));
  assert.equal(missing.code, 1);
  assert.match(missing.found.join('\n'), /Fn::ImportValue Elsewhere:Arn \(not exported by a deployed template\)/);
});

// ---------------------------------------------------------------------------------------------------------------
// Resource policies: S3, SQS, SNS, Lambda.
// ---------------------------------------------------------------------------------------------------------------

const policy = (type: string, principal: Loose | string, effect = 'Allow', condition?: Loose): Loose => ({
  Type: type,
  Properties: { PolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: effect, Action: '*', Resource: '*', Principal: principal, ...(condition ? { Condition: condition } : {}) }] } },
});
const ownArn = { 'Fn::GetAtt': ['Own', 'Arn'] };
const permission = (principal: unknown): Loose => ({ Type: 'AWS::Lambda::Permission', Properties: { Action: 'lambda:InvokeFunction', FunctionName: 'f', Principal: principal } });

const resourceCases: Array<[string, Loose, RegExp | null]> = [
  ['a bucket policy for another account stops', policy('AWS::S3::BucketPolicy', { AWS: `arn:aws:iam::${OUTSIDER}:root` }), /allows AWS arn:aws:iam::999999999999:root, outside account 818221194501/],
  ['a bucket policy for "*" stops', policy('AWS::S3::BucketPolicy', '*'), /allows "\*" \(anyone\)/],
  ['a bucket policy for AWS "*" stops', policy('AWS::S3::BucketPolicy', { AWS: '*' }), /allows "\*" \(anyone\)/],
  ['a queue policy for "*" stops', policy('AWS::SQS::QueuePolicy', { AWS: '*' }), /allows "\*"/],
  ['a topic policy for another account stops', policy('AWS::SNS::TopicPolicy', { AWS: OUTSIDER }), /allows AWS 999999999999/],
  ['a topic inline policy for another account stops', policy('AWS::SNS::TopicInlinePolicy', { AWS: OUTSIDER }), /allows AWS 999999999999/],
  ['a Lambda permission for "*" stops', permission('*'), /allows "\*" \(anyone\)/],
  ['a Lambda permission for another account stops', permission(OUTSIDER), /allows 999999999999, outside account/],
  ['a Lambda permission for a role of another account stops', permission(`arn:aws:iam::${OUTSIDER}:role/x`), /outside account/],
  ['a Lambda layer permission for "*" stops', { Type: 'AWS::Lambda::LayerVersionPermission', Properties: { Action: 'lambda:GetLayerVersion', LayerVersionArn: 'x', Principal: '*' } }, /allows "\*"/],
  ['a bucket policy denying "*" (enforceSSL) passes', policy('AWS::S3::BucketPolicy', { AWS: '*' }, 'Deny'), null],
  ['a bucket policy for CloudFront pinned by AWS:SourceArn to the project\'s distribution passes', policy('AWS::S3::BucketPolicy', { Service: 'cloudfront.amazonaws.com' }, 'Allow', { StringEquals: { 'AWS:SourceArn': { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':cloudfront::', { Ref: 'AWS::AccountId' }, ':distribution/', { Ref: 'Own' }]] } } }), null],
  ['a bucket policy for CloudFront without a source condition stops', policy('AWS::S3::BucketPolicy', { Service: 'cloudfront.amazonaws.com' }), /allows Service cloudfront\.amazonaws\.com without aws:SourceAccount or aws:SourceArn pinned/],
  ['a bucket policy for a service pinned to another account stops', policy('AWS::S3::BucketPolicy', { Service: 'logging.s3.amazonaws.com' }, 'Allow', { StringEquals: { 'aws:SourceAccount': OUTSIDER } }), /logging\.s3\.amazonaws\.com with a source condition that is not pinned to account 818221194501/],
  ['a bucket policy for a service with a negated source condition stops', policy('AWS::S3::BucketPolicy', { Service: 'logging.s3.amazonaws.com' }, 'Allow', { StringNotEquals: { 'aws:SourceAccount': ACCOUNT } }), /with a source condition that is not pinned/],
  ['a bucket policy for a service pinned by aws:SourceAccount passes', policy('AWS::S3::BucketPolicy', { Service: 'logging.s3.amazonaws.com' }, 'Allow', { StringEquals: { 'aws:SourceAccount': { Ref: 'AWS::AccountId' } } }), null],
  ['a table resource policy for another account stops', { Type: 'AWS::DynamoDB::Table', Properties: { ResourcePolicy: { PolicyDocument: { Statement: [{ Effect: 'Allow', Principal: { AWS: OUTSIDER }, Action: 'dynamodb:*', Resource: '*' }] } } } }, /allows AWS 999999999999/],
  ['a table stream resource policy for another account stops', { Type: 'AWS::DynamoDB::Table', Properties: { StreamSpecification: { StreamViewType: 'NEW_IMAGE', ResourcePolicy: { PolicyDocument: { Statement: [{ Effect: 'Allow', Principal: '*', Action: 'dynamodb:*', Resource: '*' }] } } } } }, /allows "\*"/],
  ['a global table replica resource policy for another account stops', { Type: 'AWS::DynamoDB::GlobalTable', Properties: { Replicas: [{ Region: 'us-east-1', ReplicaStreamSpecification: { ResourcePolicy: { PolicyDocument: { Statement: [{ Effect: 'Allow', Principal: { AWS: OUTSIDER }, Action: '*', Resource: '*' }] } } } }] } }, /allows AWS 999999999999/],
  ['a KMS key policy for another account stops', { Type: 'AWS::KMS::Key', Properties: { KeyPolicy: { Statement: [{ Effect: 'Allow', Principal: { AWS: `arn:aws:iam::${OUTSIDER}:root` }, Action: 'kms:*', Resource: '*' }] } } }, /allows AWS arn:aws:iam::999999999999:root/],
  ['a bucket with a public-read ACL stops', { Type: 'AWS::S3::Bucket', Properties: { AccessControl: 'PublicRead' } }, /AccessControl PublicRead grants access beyond the account/],
  ['a bucket with a public access block flag off stops', { Type: 'AWS::S3::Bucket', Properties: { PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: false, IgnorePublicAcls: true, RestrictPublicBuckets: true } } }, /BlockPublicPolicy is false/],
  ['a bucket replicating to a bucket that is not the project\'s stops', { Type: 'AWS::S3::Bucket', Properties: { ReplicationConfiguration: { Role: 'r', Rules: [{ Status: 'Enabled', Destination: { Bucket: 'arn:aws:s3:::someone-elses' } }] } } }, /replication to arn:aws:s3:::someone-elses is not one of the project's resources/],
  ['a bucket notifying a queue in another account stops', { Type: 'AWS::S3::Bucket', Properties: { NotificationConfiguration: { QueueConfigurations: [{ Event: 's3:ObjectCreated:*', Queue: `arn:aws:sqs:us-east-1:${OUTSIDER}:q` }] } } }, /notification to arn:aws:sqs:us-east-1:999999999999:q/],
  ['a bucket with an inventory going elsewhere stops (the property is not checked)', { Type: 'AWS::S3::Bucket', Properties: { InventoryConfigurations: [{ Destination: { BucketArn: 'arn:aws:s3:::x', BucketAccountId: OUTSIDER } }] } }, /property InventoryConfigurations is not checked/],
  ...(['PublicRead', 'PublicReadWrite', 'AuthenticatedRead', 'AwsExecRead'].map((acl) => [`a bucket with the ${acl} ACL stops`, { Type: 'AWS::S3::Bucket', Properties: { AccessControl: acl } }, new RegExp(`AccessControl ${acl} grants access beyond the account`)] as [string, Loose, RegExp])),
  ...(['BlockPublicAcls', 'IgnorePublicAcls', 'RestrictPublicBuckets'].map((flag) => [`a bucket with ${flag} off stops`, { Type: 'AWS::S3::Bucket', Properties: { PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true, [flag]: false } } }, new RegExp(`${flag} is false`)] as [string, Loose, RegExp])),
  ['a bucket with a public access block missing a flag stops (CloudFormation turns it off)', { Type: 'AWS::S3::Bucket', Properties: { PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true } } }, /RestrictPublicBuckets is off/],
  ['a server-access-logs bucket (LogDeliveryWrite, CDK\'s default) passes', { Type: 'AWS::S3::Bucket', Properties: { AccessControl: 'LogDeliveryWrite' } }, null],
  ['CDK\'s bucket notifications to the project\'s function, queue and topic pass', { Type: 'Custom::S3BucketNotifications', Properties: { ServiceToken: 'x', BucketName: { Ref: 'Own' }, NotificationConfiguration: { LambdaFunctionConfigurations: [{ Events: ['s3:ObjectCreated:*'], LambdaFunctionArn: ownArn }], QueueConfigurations: [{ Events: ['s3:ObjectRemoved:*'], QueueArn: ownArn }], TopicConfigurations: [{ Events: ['s3:ObjectRestore:*'], TopicArn: { Ref: 'Own' } }] } } }, null],
  ['CDK\'s bucket notifications to another account\'s function stop', { Type: 'Custom::S3BucketNotifications', Properties: { ServiceToken: 'x', BucketName: { Ref: 'Own' }, NotificationConfiguration: { LambdaFunctionConfigurations: [{ Events: ['s3:ObjectCreated:*'], LambdaFunctionArn: `arn:aws:lambda:us-east-1:${OUTSIDER}:function:f` }] } } }, /notification to arn:aws:lambda:us-east-1:999999999999:function:f/],
  ['a KMS key policy for a service without a source condition passes (the key is only used through the project\'s resources)', { Type: 'AWS::KMS::Key', Properties: { KeyPolicy: { Statement: [{ Effect: 'Allow', Principal: { Service: 's3.amazonaws.com' }, Action: ['kms:Decrypt', 'kms:GenerateDataKey*'], Resource: '*' }] } } }, null],
  ['a topic policy for EventBridge without a condition passes (CDK grants it so)', policy('AWS::SNS::TopicPolicy', { Service: 'events.amazonaws.com' }), null],
  ['a topic policy for EventBridge with another account\'s source stops', policy('AWS::SNS::TopicPolicy', { Service: 'events.amazonaws.com' }, 'Allow', { ArnEquals: { 'aws:SourceArn': `arn:aws:events:us-east-1:${OUTSIDER}:rule/r` } }), /with a source condition that is not pinned/],
  ['a log bucket policy for the region\'s Elastic Load Balancing account passes', policy('AWS::S3::BucketPolicy', { AWS: 'arn:aws:iam::127311923021:root' }), null],
  ['a queue policy for the Elastic Load Balancing account stops (only log buckets)', policy('AWS::SQS::QueuePolicy', { AWS: 'arn:aws:iam::127311923021:root' }), /outside account/],
  ['a Lambda permission for a load balancer without a source passes (CDK grants it so)', permission('elasticloadbalancing.amazonaws.com'), null],
  ['a secret resource policy for another account stops', { Type: 'AWS::SecretsManager::ResourcePolicy', Properties: { SecretId: { Ref: 'Own' }, ResourcePolicy: { Statement: [{ Effect: 'Allow', Principal: { AWS: OUTSIDER }, Action: 'secretsmanager:GetSecretValue', Resource: '*' }] } } }, /allows AWS 999999999999/],
  ['a private bucket that blocks public access passes', { Type: 'AWS::S3::Bucket', Properties: { AccessControl: 'BucketOwnerFullControl', PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true }, LoggingConfiguration: { DestinationBucketName: { Ref: 'Own' } }, NotificationConfiguration: { QueueConfigurations: [{ Event: 's3:ObjectCreated:*', Queue: ownArn }] } } }, null],
  ['a bucket policy for the account\'s roles passes', policy('AWS::S3::BucketPolicy', { AWS: [`arn:aws:iam::${ACCOUNT}:role/a`, { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':iam::', { Ref: 'AWS::AccountId' }, ':root']] }] }), null],
  ['a queue policy for SNS pinned by aws:SourceArn to the project\'s topic passes', policy('AWS::SQS::QueuePolicy', { Service: 'sns.amazonaws.com' }, 'Allow', { ArnEquals: { 'aws:SourceArn': { Ref: 'Own' } } }), null],
  ['a queue policy for SNS without a source condition stops', policy('AWS::SQS::QueuePolicy', { Service: 'sns.amazonaws.com' }), /allows Service sns\.amazonaws\.com without/],
  ['a Lambda permission for a service with the project\'s SourceArn passes', { ...permission('sns.amazonaws.com'), Properties: { ...permission('sns.amazonaws.com').Properties, SourceArn: { Ref: 'Own' } } }, null],
  ['a Lambda permission for a service with SourceAccount passes', { ...permission('s3.amazonaws.com'), Properties: { ...permission('s3.amazonaws.com').Properties, SourceAccount: { Ref: 'AWS::AccountId' } } }, null],
  ['a Lambda permission for a service without a source stops', permission('s3.amazonaws.com'), /allows Service s3\.amazonaws\.com without SourceAccount/],
  ['a Lambda permission for a service with another account\'s SourceArn stops', { ...permission('sns.amazonaws.com'), Properties: { ...permission('sns.amazonaws.com').Properties, SourceArn: `arn:aws:sns:us-east-1:${OUTSIDER}:t` } }, /with a SourceAccount or SourceArn that is not account 818221194501/],
  ['an SNS subscription to an https endpoint stops', { Type: 'AWS::SNS::Subscription', Properties: { TopicArn: { Ref: 'Own' }, Protocol: 'https', Endpoint: 'https://example.com/hook' } }, /subscription by https to https:\/\/example\.com\/hook sends messages out of the account/],
  ['an SNS subscription by email stops', { Type: 'AWS::SNS::Subscription', Properties: { TopicArn: { Ref: 'Own' }, Protocol: 'email', Endpoint: 'a@example.com' } }, /subscription by email/],
  ['an SNS subscription to another account\'s queue stops', { Type: 'AWS::SNS::Subscription', Properties: { TopicArn: { Ref: 'Own' }, Protocol: 'sqs', Endpoint: `arn:aws:sqs:us-east-1:${OUTSIDER}:q` } }, /sqs subscription to arn:aws:sqs:us-east-1:999999999999:q is not one of the project's resources/],
  ['an inline topic subscription to an https endpoint stops', { Type: 'AWS::SNS::Topic', Properties: { Subscription: [{ Protocol: 'https', Endpoint: 'https://example.com' }] } }, /subscription by https/],
  ['an SNS subscription to the project\'s queue passes', { Type: 'AWS::SNS::Subscription', Properties: { TopicArn: { Ref: 'Own' }, Protocol: 'sqs', Endpoint: ownArn } }, null],
  ['a log subscription filter to another account stops', { Type: 'AWS::Logs::SubscriptionFilter', Properties: { LogGroupName: 'g', FilterPattern: '', DestinationArn: `arn:aws:logs:us-east-1:${OUTSIDER}:destination:d` } }, /log events go to arn:aws:logs:us-east-1:999999999999:destination:d/],
  ['a log subscription filter to the project\'s function passes', { Type: 'AWS::Logs::SubscriptionFilter', Properties: { LogGroupName: 'g', FilterPattern: '', DestinationArn: ownArn } }, null],
  ['a Lambda destination in another account stops', { Type: 'AWS::Lambda::EventInvokeConfig', Properties: { FunctionName: 'f', Qualifier: '$LATEST', DestinationConfig: { OnFailure: { Destination: `arn:aws:sqs:us-east-1:${OUTSIDER}:q` } } } }, /OnFailure destination arn:aws:sqs:us-east-1:999999999999:q/],
  ['an event source mapping failure destination in another account stops', { Type: 'AWS::Lambda::EventSourceMapping', Properties: { FunctionName: 'f', DestinationConfig: { OnFailure: { Destination: `arn:aws:sns:us-east-1:${OUTSIDER}:t` } } } }, /OnFailure destination/],
  ['a dead-letter queue in another account stops', { Type: 'AWS::SQS::Queue', Properties: { RedrivePolicy: { deadLetterTargetArn: `arn:aws:sqs:us-east-1:${OUTSIDER}:dlq`, maxReceiveCount: 3 } } }, /dead letters go to/],
  ['a type shukka does not know with a policy property stops (fail closed)', { Type: 'AWS::ECR::Repository', Properties: { RepositoryPolicyText: { Statement: [] } } }, /RepositoryPolicyText: shukka does not check this type's policies, so it stops/],
  ['a custom resource with a Principal property stops (fail closed)', { Type: 'Custom::Grant', Properties: { ServiceToken: 'x', Principal: OUTSIDER } }, /Principal: shukka does not check this type's policies/],
  ['a policy document key outside the IAM grammar stops', { Type: 'AWS::S3::BucketPolicy', Properties: { PolicyDocument: { Version: '2012-10-17', Statement: [], Extra: 1 } } }, /the policy document has "Extra", which is not an IAM policy key/],
  ['a lower-case principal key stops', { Type: 'AWS::SQS::QueuePolicy', Properties: { PolicyDocument: { Statement: [{ Effect: 'Allow', Action: '*', Resource: '*', principal: '*' }] } } }, /a statement has "principal", which is not an IAM statement key/],
  ['a Lambda permission for the account passes', permission({ Ref: 'AWS::AccountId' }), null],
];

for (const [name, resource, expected] of resourceCases) {
  test(`shu-9bj.6: resource policy: ${name}`, () => {
    // Own: a resource of the project's that values can name (Ref Own, Fn::GetAtt Own.Arn).
    const r = check(assembly({ Stack: one({ P: resource, Own: { Type: 'AWS::SQS::Queue' } }) }));
    if (expected === null) {
      assert.deepEqual(r.found, []);
    } else {
      assert.equal(r.code, 1);
      assert.ok(r.found.some((line) => line.startsWith(`policy-guard: Stack.template.json: P (${resource.Type}): `) && expected.test(line)), r.found.join('\n'));
    }
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Every template: nested assemblies, nested stacks, transforms, templates that are not JSON.
// ---------------------------------------------------------------------------------------------------------------

test('shu-9bj.6: a backdoor in a nested assembly (a CDK stage) stops', () => {
  const dir = assembly({ Ci: one({ R: role({ Service: 'lambda.amazonaws.com' }) }) }, { 'assembly-Prod': { type: 'cdk:cloud-assembly', properties: { directoryName: 'assembly-Prod' } } });
  mkdirSync(join(dir, 'assembly-Prod'));
  writeFileSync(join(dir, 'assembly-Prod', 'manifest.json'), JSON.stringify({ artifacts: { 'Prod-Ci': { type: 'aws:cloudformation:stack', properties: { templateFile: 'ProdCi.template.json' } } } }));
  writeFileSync(join(dir, 'assembly-Prod', 'ProdCi.template.json'), JSON.stringify(one({ Backdoor: role({ AWS: OUTSIDER }) })));
  const r = check(dir);
  assert.equal(r.code, 1);
  assert.match(r.found.join('\n'), /^policy-guard: assembly-Prod\/ProdCi\.template\.json: Backdoor \(AWS::IAM::Role\): trusts AWS 999999999999/m);
});

test('shu-9bj.6: a backdoor in a nested stack\'s template stops; a nested stack whose template is not in the assembly stops', () => {
  const nestedUrl = { 'Fn::Join': ['', ['https://s3.', { Ref: 'AWS::Region' }, '.', { Ref: 'AWS::URLSuffix' }, '/', { 'Fn::Sub': 'cdk-trendigle-assets-${AWS::AccountId}-${AWS::Region}' }, '/abc123.json']] };
  const dir = assembly({ Parent: one({ Child: { Type: 'AWS::CloudFormation::Stack', Properties: { TemplateURL: nestedUrl } } }) }, { 'Parent.assets': { type: 'cdk:asset-manifest', properties: { file: 'Parent.assets.json' } } });
  writeFileSync(join(dir, 'ParentChild.nested.template.json'), JSON.stringify(one({ Backdoor: role({ AWS: OUTSIDER }) })));
  writeFileSync(join(dir, 'Parent.assets.json'), JSON.stringify({
    version: '48.0.0',
    files: { abc123: { source: { path: 'ParentChild.nested.template.json', packaging: 'file' }, destinations: { d: { bucketName: 'cdk-trendigle-assets-${AWS::AccountId}-${AWS::Region}', objectKey: 'abc123.json' } } } },
  }));
  const r = check(dir);
  assert.equal(r.code, 1);
  assert.match(r.found.join('\n'), /ParentChild\.nested\.template\.json: Backdoor \(AWS::IAM::Role\): trusts AWS 999999999999/);
  assert.doesNotMatch(r.found.join('\n'), /nested stack's template/, 'the nested template was found and read');

  const external = check(assembly({ Parent: one({ Child: { Type: 'AWS::CloudFormation::Stack', Properties: { TemplateURL: 'https://evil.example/abc123.json' } } }) }));
  assert.equal(external.code, 1);
  assert.match(external.found.join('\n'), /Child \(AWS::CloudFormation::Stack\): the nested stack's template \(https:\/\/evil\.example\/abc123\.json\) is not a JSON template in the assembly/);
});

test('shu-9bj.6: a transform, a macro and a stack template that is not JSON stop (they cannot be checked)', () => {
  const t = one({ R: role({ Service: 'lambda.amazonaws.com' }) });
  assert.match(check(assembly({ S: { ...t, Transform: 'AWS::Serverless-2016-10-31' } })).found.join('\n'), /has a Transform/);
  assert.match(check(assembly({ S: one({ R: { 'Fn::Transform': { Name: 'AWS::Include', Parameters: { Location: 's3://x/y' } } } }) })).found.join('\n'), /uses Fn::Transform/);
  const dir = assembly({ S: t });
  writeFileSync(join(dir, 'S.template.json'), 'Resources:\n  R:\n    Type: AWS::IAM::Role\n');
  const yaml = check(dir);
  assert.equal(yaml.code, 1);
  assert.match(yaml.found.join('\n'), /stack S template "S\.template\.json" is not a JSON template in the assembly/);
});

// ---------------------------------------------------------------------------------------------------------------
// Clean CDK apps pass: what CDK itself generates, Trendigle's shapes, and the acceptance consumer's real synth.
// ---------------------------------------------------------------------------------------------------------------

test('shu-9bj.6: a clean CDK app passes: Lambda, logRetention, BucketDeployment, autoDeleteObjects, CloudFront (OAC and OAI), SNS to SQS and Lambda, ShukkaAccess, a cross-stack role, a nested stack', () => {
  const outdir = join(scratch, `cdk-${++n}`);
  const app = new App({ outdir });
  const env = { account: ACCOUNT, region: 'us-east-1' };
  const synthesizer = () => shukkaSynthesizer('trendigle');

  const ci = new Stack(app, 'Trendigle-prod-Ci', { env, synthesizer: synthesizer() });
  const deployBucket = s3.Bucket.fromBucketName(ci, 'DeployBucket', `trendigle-deploy-${ACCOUNT}`);
  new ShukkaAccess(ci, 'Access', { project: 'trendigle', githubRepo: 'trendigle@220634492/trendigle@1462395046', deployBucket });
  new ShukkaAccess(ci, 'Rc', { project: 'trendigle', githubRepo: REPO, deployBucket, oidcProviderArn: PROVIDER, allowBranch: 'release/candidate' });

  const instance = new Stack(app, 'Trendigle-prod-Instance', { env, synthesizer: synthesizer() });
  const box = new iam.Role(instance, 'Role', { assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'), managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')] });
  new s3.Bucket(instance, 'DeployBucket', { enforceSSL: true, blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL });

  const data = new Stack(app, 'Trendigle-prod-Data', { env, synthesizer: synthesizer() });
  const media = new s3.Bucket(data, 'Media', { enforceSSL: true, autoDeleteObjects: true, removalPolicy: RemovalPolicy.DESTROY });
  media.addToResourcePolicy(new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: [media.arnForObjects('*')], principals: [box] }));
  new s3deploy.BucketDeployment(data, 'Seed', { sources: [s3deploy.Source.data('hello.txt', 'hello')], destinationBucket: media });
  const site = new s3.Bucket(data, 'Site', { enforceSSL: true });
  new cloudfront.Distribution(data, 'Cdn', { defaultBehavior: { origin: origins.S3BucketOrigin.withOriginAccessControl(site) } });
  const legacy = new s3.Bucket(data, 'Legacy');
  new cloudfront.Distribution(data, 'LegacyCdn', { defaultBehavior: { origin: origins.S3BucketOrigin.withOriginAccessIdentity(legacy) } });
  const worker = new lambda.Function(data, 'Worker', { runtime: lambda.Runtime.NODEJS_22_X, handler: 'index.handler', code: lambda.Code.fromInline('exports.handler = async () => {}'), logRetention: logs.RetentionDays.ONE_WEEK, timeout: Duration.seconds(10) });
  const topic = new sns.Topic(data, 'Events');
  topic.addSubscription(new subs.SqsSubscription(new sqs.Queue(data, 'Queue', { enforceSSL: true })));
  topic.addSubscription(new subs.LambdaSubscription(worker));
  const nested = new NestedStack(data, 'Jobs');
  new iam.Role(nested, 'JobRole', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });

  applyBoundary(app, 'trendigle');
  const dir = app.synth().directory;
  const r = check(dir);
  assert.deepEqual(r.found, [], 'nothing a CDK app generates on its own is stopped');
  assert.equal(r.verdict, 'safe');
  assert.ok(r.templates >= 4, `read ${r.templates} templates, the nested one included`);
  const types = JSON.stringify(readFileSync(join(dir, 'Trendigle-prod-Data.template.json'), 'utf8'));
  for (const t of ['AWS::S3::BucketPolicy', 'AWS::SQS::QueuePolicy', 'AWS::Lambda::Permission', 'Custom::CDKBucketDeployment', 'Custom::S3AutoDeleteObjects', 'Custom::LogRetention', 'AWS::CloudFormation::Stack']) {
    assert.ok(types.includes(t), `the fixture really has ${t}`);
  }
  assert.ok(types.includes('Fn::ImportValue'), 'the media bucket policy names the instance role through an import');
});

test('shu-9bj.6: Trendigle\'s current templates pass except its old Ci role, which trusts its own provider without job_workflow_ref', () => {
  // The shapes of Trendigle's cdk.out today (recorded): the instance role, enforceSSL bucket policies, its old deploy role.
  const instance = one({
    Role1ABCC5F0: { Type: 'AWS::IAM::Role', Properties: { AssumeRolePolicyDocument: { Statement: [{ Action: 'sts:AssumeRole', Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' } }], Version: '2012-10-17' } } },
    DeployBucket67E2C076: { Type: 'AWS::S3::Bucket' },
    DeployBucketPolicyCED076FF: { Type: 'AWS::S3::BucketPolicy', Properties: { Bucket: { Ref: 'DeployBucket67E2C076' }, PolicyDocument: { Statement: [{ Action: 's3:*', Condition: { Bool: { 'aws:SecureTransport': 'false' } }, Effect: 'Deny', Principal: { AWS: '*' }, Resource: [{ 'Fn::GetAtt': ['DeployBucket67E2C076', 'Arn'] }, { 'Fn::Join': ['', [{ 'Fn::GetAtt': ['DeployBucket67E2C076', 'Arn'] }, '/*']] }] }], Version: '2012-10-17' } } },
  });
  assert.deepEqual(check(assembly({ 'Trendigle-prod-Instance': instance })).found, []);
  const oldCi = one({
    GitHub38B7EEC4: { Type: 'Custom::AWSCDKOpenIdConnectProvider' },
    DeployRole885297C3: role({ Federated: { Ref: 'GitHub38B7EEC4' } }, { StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com', 'token.actions.githubusercontent.com:sub': 'repo:trendigle@220634492/trendigle@1462395046:ref:refs/heads/main' } }),
  });
  const r = check(assembly({ 'Trendigle-prod-Ci': oldCi }));
  assert.equal(r.code, 1);
  assert.match(r.found.join('\n'), /DeployRole885297C3 \(AWS::IAM::Role\): trusts Federated <Ref GitHub38B7EEC4>/);
});

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
    account: ACCOUNT, region: 'us-east-1', runId: '1', githubRepoSubject: 'rummykhan/shukka-consumer-test',
    oidcProviderArn: PROVIDER, hostedZoneId: 'Z0123456789ABC', zoneName: 'shukkatest.example.com',
    vpcId: 'vpc-0123456789abcdef0', subnetId: 'subnet-0123456789abcdef0', availabilityZone: 'us-east-1a', amiId: 'ami-0123456789abcdef0',
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

test('shu-9bj.6: the acceptance consumer\'s real synth passes; the same synth with a planted backdoor role stops', () => {
  const out = synthConsumer();
  const ok = policyGuard(out, { account: ACCOUNT, repos: ['rummykhan/shukka-consumer-test'] });
  assert.deepEqual(ok.found, []);
  assert.equal(ok.templates, 2);
  const ci = JSON.parse(readFileSync(join(out, 'Shukkatest-Ci.template.json'), 'utf8'));
  assert.equal((Object.values(ci.Resources) as Loose[]).filter((x) => x.Type === 'AWS::IAM::Role').length, 3, 'the three ShukkaAccess roles were checked');

  ci.Resources.Backdoor = role({ AWS: `arn:aws:iam::${OUTSIDER}:root` }, undefined, 'shukkatest-backdoor');
  writeFileSync(join(out, 'Shukkatest-Ci.template.json'), JSON.stringify(ci));
  const stopped = policyGuard(out, { account: ACCOUNT, repos: ['rummykhan/shukka-consumer-test'] });
  assert.equal(stopped.code, 1);
  assert.deepEqual(stopped.found, ['policy-guard: Shukkatest-Ci.template.json: Backdoor (AWS::IAM::Role): trusts AWS arn:aws:iam::999999999999:root, which is not a role of account 818221194501']);
  // Run for another repository, the consumer's own roles stop too: the subject is pinned.
  const other = checkPolicies(synthConsumer(), { account: ACCOUNT, repos: ['someone/else'] });
  assert.ok('problems' in other);
  assert.equal(other.problems.filter((p) => /names another repository than the project's \(someone\/else\)/.test(p)).length, 3);
});

test('shu-9bj.6: the git remote of a GitHub repository gives owner/repo; others give nothing', () => {
  assert.equal(githubRepoFromUrl('git@github.com:trendigle/trendigle.git'), 'trendigle/trendigle');
  assert.equal(githubRepoFromUrl('https://github.com/rummykhan/shukka-consumer-test.git\n'), 'rummykhan/shukka-consumer-test');
  assert.equal(githubRepoFromUrl('ssh://git@github.com/a/b'), 'a/b');
  assert.equal(githubRepoFromUrl('/tmp/origin.git'), null);
  assert.equal(githubRepoFromUrl('https://gitlab.com/a/b.git'), null);
});

// ---------------------------------------------------------------------------------------------------------------
// The workflow: deploy and PR diff jobs run it after assembly.mjs and before any role (dry run of the steps' bash).
// ---------------------------------------------------------------------------------------------------------------

const infra = parse(readFileSync(join(root, '.github', 'workflows', 'infra.yml'), 'utf8')) as Loose;
const STEP = 'Check trust and resource policies';
const stepsOf = (job: string): Loose[] => infra.jobs[job].steps;
const stepOf = (job: string, name: string): Loose => {
  const s = stepsOf(job).find((x) => x.name === name);
  assert.ok(s, `${job}: ${name}`);
  return s;
};

test('shu-9bj.6: deploy and diff run the policy guard after the assembly check and before any role is assumed', () => {
  for (const job of ['deploy', 'diff']) {
    const names = stepsOf(job).map((s) => s.name ?? s.uses);
    const at = names.indexOf(STEP);
    assert.ok(at > names.indexOf('Check the assembly') && names.indexOf('Check the assembly') >= 0, `${job}: ${names.join(', ')}`);
    const firstRole = stepsOf(job).findIndex((s) => String(s.uses ?? '').startsWith('aws-actions/configure-aws-credentials') || /sts assume-role/.test(s.run ?? ''));
    assert.ok(firstRole > at, `${job}: before any role (${names[firstRole]})`);
    assert.match(stepOf(job, STEP).run, /node \.shukka\/scripts\/policy-guard\.mjs "\$RUNNER_TEMP\/cdk\.out" --account "\$ACCOUNT" --repo "\$GITHUB_REPOSITORY"/);
    assert.equal(stepOf(job, STEP).env.ACCOUNT, '${{ steps.config.outputs.account }}');
  }
});

/** Run one step's bash the way GitHub does, in a workspace whose .shukka is this checkout and cdk.out is `asm`. */
async function runStep(job: string, name: string, asm: string, exprs: Record<string, string>, extraEnv: Record<string, string> = {}) {
  const ws = join(scratch, `ws-${++n}`);
  const temp = join(ws, 'runner-temp');
  mkdirSync(temp, { recursive: true });
  symlinkSync(root, join(ws, '.shukka'));
  cpSync(asm, join(temp, 'cdk.out'), { recursive: true });
  const s = stepOf(job, name);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries((s.env ?? {}) as Record<string, string>)) {
    env[k] = String(v).replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, e: string) => {
      assert.ok(e in exprs, `give \${{ ${e} }}`);
      return exprs[e] as string;
    });
  }
  const files = { summary: join(temp, 'summary'), output: join(temp, 'output') };
  for (const f of Object.values(files)) writeFileSync(f, '');
  writeFileSync(join(temp, 'step.sh'), s.run);
  const child = spawn('bash', ['--noprofile', '--norc', '-eo', 'pipefail', join(temp, 'step.sh')], {
    cwd: ws,
    env: { PATH: `${dirname(process.execPath)}:${process.env.PATH}`, HOME: ws, RUNNER_TEMP: temp, GITHUB_STEP_SUMMARY: files.summary, GITHUB_OUTPUT: files.output, GITHUB_REPOSITORY: REPO, ...env, ...extraEnv },
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const code = await new Promise<number>((r) => child.on('close', (c) => r(c ?? -1)));
  return { code, out, summary: readFileSync(files.summary, 'utf8'), temp };
}

const backdoor = () => assembly({ 'Trendigle-prod-Ci': one({ Backdoor: role({ AWS: `arn:aws:iam::${OUTSIDER}:root` }) }) });
const clean = () => assembly({ 'Trendigle-prod-Ci': one({ Infra: role({ Federated: PROVIDER }, shukkaConditions(), 'trendigle-shukka-infra') }) });
const deployExprs = (allow: string, event: string) => ({ 'steps.config.outputs.account': ACCOUNT, 'inputs.allow_replacement': allow, 'github.event_name': event });

test('shu-9bj.6: the deploy job stops on a backdoor with the verdict in the step summary; passes a clean assembly', async () => {
  const stopped = await runStep('deploy', STEP, backdoor(), deployExprs('false', 'push'));
  assert.equal(stopped.code, 1, stopped.out);
  assert.match(stopped.out, /Backdoor \(AWS::IAM::Role\): trusts AWS arn:aws:iam::999999999999:root/);
  assert.match(stopped.out, /^::error::shukka: the policy guard stopped the infrastructure deploy$/m);
  assert.match(stopped.summary, /^### Trust and resource policies\n\n\*\*Stopped:\*\*/);
  const ok = await runStep('deploy', STEP, clean(), deployExprs('false', 'push'));
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.summary, /No trust or resource policy lets a principal outside the project in/);
});

test('shu-9bj.6: allow_replacement lets the policy guard through only on a run started by hand', async () => {
  const byHand = await runStep('deploy', STEP, backdoor(), deployExprs('true', 'workflow_dispatch'));
  assert.equal(byHand.code, 0, byHand.out);
  assert.match(byHand.out, /^policy-guard: allowed by the person who started this run \(--allow\)$/m);
  const onPush = await runStep('deploy', STEP, backdoor(), deployExprs('true', 'push'));
  assert.equal(onPush.code, 1);
  assert.match(onPush.out, /allow_replacement is honoured only when the workflow is run by hand/);
});

test('shu-9bj.6: the PR diff job never fails on a backdoor, leaves the verdict for the comment, and the comment says the merge will stop', async () => {
  const r = await runStep('diff', STEP, backdoor(), { 'steps.config.outputs.account': ACCOUNT });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /::warning::shukka: this merge will stop at the policy guard/);
  assert.match(r.summary, /### Trust and resource policies/);
  const dir = join(r.temp, 'shukka-pr-diff');
  assert.equal(readFileSync(join(dir, 'policy-guard-status'), 'utf8').trim(), '1');
  assert.match(readFileSync(join(dir, 'policy-guard.txt'), 'utf8'), /Backdoor \(AWS::IAM::Role\)/);
  const clean0 = await runStep('diff', STEP, clean(), { 'steps.config.outputs.account': ACCOUNT });
  assert.equal(readFileSync(join(clean0.temp, 'shukka-pr-diff', 'policy-guard-status'), 'utf8').trim(), '0');

  // The comment job, against a fake GitHub API, with the diff guard's files as the diff job leaves them.
  writeFileSync(join(dir, 'diff.txt'), 'Stack Trendigle-prod-Ci\nResources\n[+] AWS::IAM::Role Backdoor Backdoor\n\n✨  Number of stacks with differences: 1\n');
  writeFileSync(join(dir, 'guard.txt'), 'guard: nothing is deleted or replaced\n');
  writeFileSync(join(dir, 'guard-status'), '0\n');
  const posted: string[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'POST') posted.push(JSON.parse(body).body);
      res.end(req.method === 'GET' ? '[]' : '{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const comment = stepOf('comment', 'Comment on the pull request');
    writeFileSync(join(r.temp, 'comment.sh'), comment.run);
    const child = spawn('bash', ['--noprofile', '--norc', '-eo', 'pipefail', join(r.temp, 'comment.sh')], {
      cwd: dirname(r.temp),
      env: { PATH: process.env.PATH, RUNNER_TEMP: r.temp, GITHUB_TOKEN: 't', PR_NUMBER: '3', GITHUB_API_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, GITHUB_REPOSITORY: REPO },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const code = await new Promise<number>((res) => child.on('close', (c) => res(c ?? -1)));
    assert.equal(code, 0, out);
    assert.equal(posted.length, 1);
    assert.match(posted[0] as string, /\*\*This merge will stop\*\* at the policy guard: a trust or resource policy lets a principal outside the project in/);
    assert.match(posted[0] as string, /### Trust and resource policies\n\n```\n[\s\S]*Backdoor \(AWS::IAM::Role\)/);
    assert.doesNotMatch(posted[0] as string, /at the guard:/, 'the destructive-change guard passed');
  } finally {
    await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The fence: executionC denies changes to the pipeline's own roles.
// ---------------------------------------------------------------------------------------------------------------

test('shu-9bj.6: executionC denies re-trusting, deleting or adding policies to <project>-shukka-* roles', () => {
  const d = fenceDocuments({ project: 'trendigle', account: ACCOUNT, region: 'us-east-1', qualifier: 'trendigle', hostedZoneId: 'Z0369023VBLJHX9H3LHA', sesDomains: ['trendigle.com'] });
  const deny = d.executionC.Statement.find((s) => s.Sid === 'NoChangeToCiRoles');
  assert.ok(deny, 'the statement is in executionC');
  assert.equal(deny.Effect, 'Deny');
  assert.deepEqual([...(deny.Action as string[])].sort(), ['iam:AttachRolePolicy', 'iam:DeleteRole', 'iam:DeleteRolePolicy', 'iam:DetachRolePolicy', 'iam:PutRolePolicy', 'iam:UpdateAssumeRolePolicy']);
  assert.deepEqual(deny.Resource, [`arn:aws:iam::${ACCOUNT}:role/trendigle-shukka-*`, `arn:aws:iam::${ACCOUNT}:role/Trendigle-shukka-*`]);
  for (const doc of [d.executionA, d.executionB, d.boundary]) assert.ok(!doc.Statement.some((s) => s.Sid === 'NoChangeToCiRoles'));

  // The boundary (servers, Lambdas, custom resources) cannot write resource policies after the guard read the templates.
  const writes = d.boundary.Statement.find((s) => s.Sid === 'NoPolicyWrites');
  assert.ok(writes && writes.Effect === 'Deny' && writes.Resource === '*');
  assert.deepEqual(writes.Action, [
    's3:*BucketPolicy', 's3:Put*Acl', 's3:*PublicAccessBlock', 's3:PutBucketOwnership*', 'sqs:AddPermission', 'sqs:Set*',
    'sns:AddPermission', 'sns:SetTopicAttributes', 'sns:Subscribe', 'lambda:Add*Permission', 'lambda:*FunctionUrlConfig',
    'dynamodb:PutResource*', 'logs:PutSubscriptionFilter', 'logs:PutDestination*',
  ]);
  for (const doc of [d.executionA, d.executionB, d.executionC]) assert.ok(!doc.Statement.some((s) => s.Sid === 'NoPolicyWrites'), 'the execution role still applies template policies');
  assert.match(readFileSync(join(root, 'test', 'simulate', 'run.mjs'), 'utf8'), /'bounded', 'explicitDeny', 's3:PutBucketPolicy'/);
  assert.ok(existsSync(join(root, 'test', 'simulate', 'run.mjs')));
  assert.match(readFileSync(join(root, 'test', 'simulate', 'run.mjs'), 'utf8'), /'explicitDeny', 'iam:UpdateAssumeRolePolicy', `arn:aws:iam::\$\{A\}:role\/trendigle-shukka-infra`/);
});

// ---------------------------------------------------------------------------------------------------------------
// The security review's fixtures (test/fixtures/policy/A-H) and what they showed.
// ---------------------------------------------------------------------------------------------------------------

const reviewFixture = (name: string) => join(root, 'test', 'fixtures', 'policy', name);

test('shu-9bj.6: review A: a stack whose stackTemplateAssetObjectUrl deploys a YAML file asset, not its templateFile, stops in assembly.mjs and the policy guard', () => {
  const a = checkAssembly(reviewFixture('A')).join('\n');
  assert.match(a, /^assembly: manifest\.json: stack S deploys s3:\/\/cdk-hnb659fds-assets-818221194501-us-east-1\/evil\.yaml, published from evil\.yaml, not its templateFile S\.template\.json; refused$/m);
  assert.match(a, /^assembly: S\.assets\.json: file asset evil \(evil\.yaml\) looks like a template but is not a JSON object/m);
  const r = check(reviewFixture('A'));
  assert.equal(r.code, 1);
  assert.match(r.found.join('\n'), /stack S deploys .*evil\.yaml.*not its templateFile/);
});

test('shu-9bj.6: a stack deploying exactly its own templateFile passes; a URL no asset publishes, or two assets on one key from different files, stop', () => {
  const B = `cdk-hnb659fds-assets-${ACCOUNT}-us-east-1`;
  const build = (url: string, files: Loose) => {
    const dir = assembly({ S: one({ Q: { Type: 'AWS::SQS::Queue' } }) }, { 'S.assets': { type: 'cdk:asset-manifest', properties: { file: 'S.assets.json' } } });
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    manifest.artifacts.S.properties.stackTemplateAssetObjectUrl = url;
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
    writeFileSync(join(dir, 'S.assets.json'), JSON.stringify({ version: '48.0.0', files }));
    return dir;
  };
  const asset = (path: string, key: string) => ({ source: { path, packaging: 'file' }, destinations: { d: { bucketName: B, objectKey: key } } });
  const ok = build(`s3://${B}/t.json`, { t: asset('S.template.json', 't.json') });
  assert.deepEqual(checkAssembly(ok), []);
  assert.deepEqual(check(ok).found, []);
  assert.match(checkAssembly(build(`s3://${B}/missing.json`, { t: asset('S.template.json', 't.json') })).join('\n'), /deploys s3:\/\/.*\/missing\.json, which no file asset publishes/);
  const twice = build(`s3://${B}/t.json`, { t: asset('S.template.json', 't.json'), u: asset('other.json', 't.json') });
  writeFileSync(join(twice, 'other.json'), JSON.stringify(one({ Backdoor: role({ AWS: OUTSIDER }) })));
  assert.match(checkAssembly(twice).join('\n'), /two file assets are published to .*\/t\.json from different files \(S\.template\.json, other\.json\)/);
});

test('shu-9bj.6: review B: a Custom::AWS writing a bucket policy passes the template check; the boundary denies the call (see the boundary test)', () => {
  assert.equal(check(reviewFixture('B')).code, 0, 'the guard cannot read an SDK call inside a custom resource; NoPolicyWrites in the boundary stops it at run time');
});

test('shu-9bj.6: review C-H: a table resource policy, an unpinned service permission, a lower-case principal key, a computed outside account, a decoy export and a planted branches key all stop', () => {
  const expect: Record<string, RegExp> = {
    C: /T \(AWS::DynamoDB::Table\): allows AWS arn:aws:iam::999999999999:root/,
    D: /P \(AWS::Lambda::Permission\): allows Service s3\.amazonaws\.com without SourceAccount/,
    E: /R \(AWS::IAM::Role\): policy cannot be read: a statement has "principal", which is not an IAM statement key/,
    F: /R \(AWS::IAM::Role\): trusts AWS arn:aws:iam::999999999999:root/,
    G: /Use\.template\.json: R \(AWS::IAM::Role\): trusts AWS 999999999999/,
    H: /policy cannot be read: the policy document has "\\u0000branches", which is not an IAM policy key/,
  };
  for (const [name, re] of Object.entries(expect)) {
    const r = check(reviewFixture(name));
    assert.equal(r.code, 1, name);
    assert.match(r.found.join('\n'), re, `${name}: ${r.found.join('\n')}`);
  }
  assert.ok(existsSync(join(reviewFixture('G'), 'zz-decoy.json')), 'G carries a decoy export in a file no stack deploys');
});

test('shu-9bj.6: an export defined by two deployed templates stops', () => {
  const exp = (value: string) => ({ ...one({ Q: { Type: 'AWS::SQS::Queue' } }), Outputs: { O: { Value: value, Export: { Name: 'trusted' } } } });
  const r = check(assembly({ A: exp(`arn:aws:iam::${ACCOUNT}:role/a`), B: exp(OUTSIDER), C: one({ R: role({ AWS: { 'Fn::ImportValue': 'trusted' } }) }) }));
  assert.equal(r.code, 1);
  assert.match(r.found.join('\n'), /the export trusted is defined 2 times/);
});

test('shu-9bj.6: an Fn::If whose branches are policy documents checks both, and a planted "\\u0000branches" key is just a bad key', () => {
  const doc = (p: string) => ({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'sts:AssumeRole', Principal: { AWS: p } }] });
  const r = check(assembly({ S: one({ R: { Type: 'AWS::IAM::Role', Properties: { AssumeRolePolicyDocument: { 'Fn::If': ['C', doc(`arn:aws:iam::${ACCOUNT}:role/a`), doc(OUTSIDER)] } } } }) }));
  assert.equal(r.code, 1);
  assert.match(r.found.join('\n'), /trusts AWS 999999999999/);
});
