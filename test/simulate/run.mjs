// Runs spike S2's 58 cases (docs/factory/v1/spikes/s2/simulate.py) through the IAM policy simulator against the
// documents ShukkaBoundary synthesizes, plus the cases for the SendCommand loophole the construct closes (finding 4).
// Needs AWS credentials; the only call is `iam simulate-custom-policy`, which is read-only. Not part of the gate.
//
//   AWS_PROFILE=stelking node test/simulate/run.mjs
//
// Account-neutral: the simulator evaluates ARNs as strings, so a placeholder account works as well as the real one.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tsImport } from 'tsx/esm/api';

const run = promisify(execFile);
const { synthFence } = await tsImport('./synth.ts', import.meta.url);

const A = '123456789012';
const R = 'us-east-1';
const d = synthFence({
  project: 'trendigle',
  account: A,
  region: R,
  qualifier: 'trendigle',
  hostedZoneId: 'Z0369023VBLJHX9H3LHA',
  sesDomains: ['trendigle.com', 'mail.trendigle.com'],
});
const BOUNDARY = `arn:aws:iam::${A}:policy/trendigle-shukka-boundary`;
const EX = [d.executionA, d.executionB];
const ALLOW_ALL = { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }] };
const T = { 'aws:ResourceTag/Project': 'trendigle' };
const O = { 'aws:ResourceTag/Project': 'orbitary' };

// [who, expected, action, resource, context]
const cases = [
  ['exec', 'allowed', 'dynamodb:CreateTable', `arn:aws:dynamodb:${R}:${A}:table/trendigle_prod_login_attempts`],
  ['exec', 'allowed', 'dynamodb:UpdateTimeToLive', `arn:aws:dynamodb:${R}:${A}:table/trendigle_prod_login_attempts`],
  ['exec', 'allowed', 'dynamodb:DeleteTable', `arn:aws:dynamodb:${R}:${A}:table/trendigle-prod`],
  ['exec', 'allowed', 's3:PutBucketPolicy', `arn:aws:s3:::trendigle-prod-deploy-${A}`],
  ['exec', 'allowed', 's3:PutLifecycleConfiguration', `arn:aws:s3:::trendigle-prod-media-${A}`],
  ['exec', 'allowed', 'iam:CreateRole', `arn:aws:iam::${A}:role/Trendigle-prod-Instance-Role1ABCC5F0-5uGLbHErVSKT`, { 'iam:PermissionsBoundary': BOUNDARY }],
  ['exec', 'allowed', 'iam:PutRolePolicy', `arn:aws:iam::${A}:role/Trendigle-prod-Instance-Role1ABCC5F0-5uGLbHErVSKT`, { 'iam:PermissionsBoundary': BOUNDARY }],
  ['exec', 'allowed', 'iam:PutRolePermissionsBoundary', `arn:aws:iam::${A}:role/trendigle-prod-github-deploy`, { 'iam:PermissionsBoundary': BOUNDARY }],
  ['exec', 'allowed', 'iam:PassRole', `arn:aws:iam::${A}:role/Trendigle-prod-Instance-Role1ABCC5F0-5uGLbHErVSKT`, { 'iam:PassedToService': 'ec2.amazonaws.com' }],
  ['exec', 'allowed', 'iam:AddRoleToInstanceProfile', `arn:aws:iam::${A}:instance-profile/Trendigle-prod-Instance-BoxInstanceProfile638444A1-TnKxws6n6v13`],
  ['exec', 'allowed', 'ec2:ModifyInstanceAttribute', `arn:aws:ec2:${R}:${A}:instance/i-07c0a9b38ff703056`, T],
  ['exec', 'allowed', 'ec2:RunInstances', `arn:aws:ec2:${R}:${A}:instance/*`, { 'aws:RequestTag/Project': 'trendigle' }],
  ['exec', 'allowed', 'ec2:AuthorizeSecurityGroupIngress', `arn:aws:ec2:${R}:${A}:security-group/sg-0abbdc99f01a29c9e`, T],
  ['exec', 'allowed', 'route53:ChangeResourceRecordSets', 'arn:aws:route53:::hostedzone/Z0369023VBLJHX9H3LHA'],
  ['exec', 'allowed', 'lambda:CreateFunction', `arn:aws:lambda:${R}:${A}:function:Trendigle-prod-Notify-Worker`],
  ['exec', 'allowed', 'sqs:CreateQueue', `arn:aws:sqs:${R}:${A}:trendigle-prod-events`],
  ['exec', 'allowed', 'ssm:GetParameter', `arn:aws:ssm:${R}:${A}:parameter/cdk-bootstrap/trendigle/version`],
  ['exec', 'implicitDeny', 'dynamodb:DeleteTable', `arn:aws:dynamodb:${R}:${A}:table/orbitary-prod-entities`],
  ['exec', 'implicitDeny', 's3:DeleteBucket', `arn:aws:s3:::orbitary-prod-media-${A}`],
  ['exec', 'implicitDeny', 'iam:UpdateAssumeRolePolicy', `arn:aws:iam::${A}:role/Orbitary-prod-Instance-OrbitaryRole3A86A241-ivuB5uMdphsm`],
  ['exec', 'implicitDeny', 'iam:CreateRole', `arn:aws:iam::${A}:role/trendigle-escape`],
  ['exec', 'implicitDeny', 'iam:CreateRole', `arn:aws:iam::${A}:role/trendigle-escape`, { 'iam:PermissionsBoundary': `arn:aws:iam::${A}:policy/other` }],
  ['exec', 'explicitDeny', 'iam:DeleteRolePermissionsBoundary', `arn:aws:iam::${A}:role/Trendigle-prod-Instance-Role1ABCC5F0-5uGLbHErVSKT`],
  ['exec', 'explicitDeny', 'iam:CreatePolicyVersion', BOUNDARY],
  ['exec', 'implicitDeny', 'iam:PassRole', `arn:aws:iam::${A}:role/Orbitary-prod-Instance-OrbitaryRole3A86A241-ivuB5uMdphsm`, { 'iam:PassedToService': 'ec2.amazonaws.com' }],
  ['exec', 'implicitDeny', 'ec2:TerminateInstances', `arn:aws:ec2:${R}:${A}:instance/i-0orbitary`, O],
  ['exec', 'implicitDeny', 'ec2:RunInstances', `arn:aws:ec2:${R}:${A}:instance/*`, { 'aws:RequestTag/Project': 'orbitary' }],
  ['exec', 'implicitDeny', 'route53:ChangeResourceRecordSets', 'arn:aws:route53:::hostedzone/ZOTHERZONE'],
  ['exec', 'implicitDeny', 'iam:CreateOpenIDConnectProvider', `arn:aws:iam::${A}:oidc-provider/token.actions.githubusercontent.com`],
  ['exec', 'implicitDeny', 'iam:AttachRolePolicy', `arn:aws:iam::${A}:role/trendigle-x`],
  ['exec', 'implicitDeny', 'cloudformation:DeleteStack', `arn:aws:cloudformation:${R}:${A}:stack/Orbitary-prod-Data/x`],
  // What today's Trendigle roles do, which the boundary must still allow (identity policy allows everything, so
  // only the boundary decides).
  ['bounded', 'allowed', 'dynamodb:PutItem', `arn:aws:dynamodb:${R}:${A}:table/trendigle_prod_posts`],
  ['bounded', 'allowed', 'dynamodb:Query', `arn:aws:dynamodb:${R}:${A}:table/trendigle_prod_posts/index/by_time`],
  ['bounded', 'allowed', 'dynamodb:GetItem', `arn:aws:dynamodb:${R}:${A}:table/trendigle-prod`],
  ['bounded', 'allowed', 's3:GetObject', `arn:aws:s3:::trendigle-prod-media-${A}/u/x.png`],
  ['bounded', 'allowed', 's3:GetObject', `arn:aws:s3:::trendigle-prod-deploy-${A}/app/bundle.tgz`],
  ['bounded', 'allowed', 's3:PutObject', `arn:aws:s3:::trendigle-prod-deploy-${A}/trendigle/app/abc.tgz`],
  ['bounded', 'allowed', 'ssm:GetParametersByPath', `arn:aws:ssm:${R}:${A}:parameter/trendigle/prod`],
  ['bounded', 'allowed', 'ssm:GetParameter', `arn:aws:ssm:${R}:${A}:parameter/trendigle/prod/SESSION_SECRET`],
  ['bounded', 'allowed', 'kms:Decrypt', `arn:aws:kms:${R}:${A}:key/abc`, { 'kms:ViaService': `ssm.${R}.amazonaws.com` }],
  ['bounded', 'allowed', 'ssmmessages:CreateControlChannel', '*'],
  ['bounded', 'allowed', 'ssm:UpdateInstanceInformation', `arn:aws:ec2:${R}:${A}:instance/i-07c0a9b38ff703056`],
  ['bounded', 'allowed', 'ec2messages:GetMessages', '*'],
  ['bounded', 'allowed', 'ssm:SendCommand', `arn:aws:ssm:${R}::document/AWS-RunShellScript`],
  ['bounded', 'allowed', 'ssm:SendCommand', `arn:aws:ec2:${R}:${A}:instance/i-07c0a9b38ff703056`, T],
  ['bounded', 'allowed', 'sts:AssumeRole', `arn:aws:iam::${A}:role/cdk-trendigle-deploy-role-${A}-${R}`],
  ['bounded', 'allowed', 'ses:SendRawEmail', `arn:aws:ses:${R}:${A}:identity/mail.trendigle.com`, { 'ses:FromAddress': 'no-reply@mail.trendigle.com' }],
  ['bounded', 'allowed', 'sqs:SendMessage', `arn:aws:sqs:${R}:${A}:trendigle-prod-events`],
  ['bounded', 'implicitDeny', 'dynamodb:Scan', `arn:aws:dynamodb:${R}:${A}:table/orbitary-prod-entities`],
  ['bounded', 'implicitDeny', 's3:GetObject', `arn:aws:s3:::orbitary-prod-media-${A}/x`],
  ['bounded', 'implicitDeny', 'ssm:GetParameter', `arn:aws:ssm:${R}:${A}:parameter/orbitary/prod/SECRET`],
  ['bounded', 'implicitDeny', 'ssm:SendCommand', `arn:aws:ec2:${R}:${A}:instance/i-0orbitary`, O],
  ['bounded', 'implicitDeny', 'iam:CreateRole', `arn:aws:iam::${A}:role/trendigle-x`],
  ['bounded', 'implicitDeny', 'iam:PutRolePolicy', `arn:aws:iam::${A}:role/Trendigle-prod-Instance-Role1ABCC5F0-5uGLbHErVSKT`],
  ['bounded', 'implicitDeny', 'ec2:RunInstances', `arn:aws:ec2:${R}:${A}:instance/*`],
  ['bounded', 'implicitDeny', 'sts:AssumeRole', `arn:aws:iam::${A}:role/cdk-hnb659fds-deploy-role-${A}-${R}`],
  ['bounded', 'implicitDeny', 'iam:CreateOpenIDConnectProvider', `arn:aws:iam::${A}:oidc-provider/token.actions.githubusercontent.com`],
  ['bounded', 'implicitDeny', 'ses:SendRawEmail', `arn:aws:ses:${R}:${A}:identity/mail.trendigle.com`, { 'ses:FromAddress': 'x@evil.example' }],
];
// Spike S2 finding 4: an instance without a Project tag, and another document, are now refused.
const extra = [
  ['bounded', 'implicitDeny', 'ssm:SendCommand', `arn:aws:ec2:${R}:${A}:instance/i-0untagged`],
  ['bounded', 'implicitDeny', 'ssm:SendCommand', `arn:aws:ssm:${R}::document/AWS-RunPowerShellScript`],
];

async function simulate([who, , action, resource, ctx]) {
  const policies = who === 'exec' ? EX : [ALLOW_ALL];
  const args = ['iam', 'simulate-custom-policy', '--policy-input-list', ...policies.map((p) => JSON.stringify(p)),
    '--action-names', action, '--resource-arns', resource, '--output', 'json'];
  if (who === 'bounded') args.push('--permissions-boundary-policy-input-list', JSON.stringify(d.boundary));
  if (ctx) {
    args.push('--context-entries', JSON.stringify(Object.entries(ctx).map(([k, v]) => ({ ContextKeyName: k, ContextKeyValues: [v], ContextKeyType: 'string' }))));
  }
  const { stdout } = await run('aws', args, { maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(stdout).EvaluationResults[0].EvalDecision;
}

// A few calls at a time; the simulator throttles bursts.
async function runAll(list) {
  const results = new Array(list.length);
  let next = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (next < list.length) {
      const i = next++;
      results[i] = await simulate(list[i]);
    }
  }));
  return results;
}

let failed = 0;
async function report(title, list) {
  const got = await runAll(list);
  let ok = 0;
  list.forEach(([who, want, action, resource], i) => {
    const pass = got[i] === want;
    if (pass) ok++; else failed++;
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${who.padEnd(7)} ${action.padEnd(38)} ${resource.split(':').pop().slice(0, 60).padEnd(60)} ${got[i]}${pass ? '' : ` (want ${want})`}`);
  });
  console.log(`${title}: ${ok} ok of ${list.length}\n`);
}

await report('spike S2 cases', cases);
await report('finding 4 (SendCommand split)', extra);
process.exit(failed ? 1 : 0);
