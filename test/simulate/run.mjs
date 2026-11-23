// Runs spike S2's 58 cases (docs/factory/v1/spikes/s2/simulate.py) through the IAM policy simulator against the
// documents ShukkaBoundary synthesizes, plus cases for each hole in the spike the construct closes. Two spike cases
// are changed (marked) because the call they model now needs a tag or a principal the spike did not check. Then the
// project bootstrap's deploy and file-publishing role policies (lib/bootstrap.ts, shu-9bj.2, shu-9bj.4).
// Needs AWS credentials; the only call is `iam simulate-custom-policy`, which is read-only. Not part of the gate.
//
//   AWS_PROFILE=stelking node test/simulate/run.mjs
//
// Account-neutral: the simulator evaluates ARNs as strings, so a placeholder account works as well as the real one.
// Every account, instance, security group, hosted zone and role id here is a dummy (shu-9bj.9).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tsImport } from 'tsx/esm/api';

const run = promisify(execFile);
const { synthFence } = await tsImport('./synth.ts', import.meta.url);
const { synthBootstrap } = await tsImport('./bootstrap.ts', import.meta.url);
const { bootstrapStackName, boundaryStackName } = await tsImport('../../lib/bootstrap.ts', import.meta.url);

const A = '123456789012';
const R = 'us-east-1';
const d = synthFence({
  project: 'trendigle',
  account: A,
  region: R,
  qualifier: 'trendigle',
  hostedZoneId: 'Z0123456789EXAMPLE',
  sesDomains: ['trendigle.com', 'mail.trendigle.com'],
});
const BOUNDARY = `arn:aws:iam::${A}:policy/trendigle-shukka-boundary`;
const SSO_ADMIN = `arn:aws:iam::${A}:role/aws-reserved/sso.amazonaws.com/AWSReservedSSO_AdministratorAccess_*`;
const boot = synthBootstrap({ project: 'trendigle', account: A, region: R });
const bootAdmin = synthBootstrap({ project: 'trendigle', account: A, region: R, emergencyPrincipals: [SSO_ADMIN] });
const bootOther = synthBootstrap({ project: 'trendigle', qualifier: 'tq', account: A, region: R });
const EX = [d.executionA, d.executionB, d.executionC];
const ALLOW_ALL = { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }] };
const T = { 'aws:ResourceTag/Project': 'trendigle' };
const O = { 'aws:ResourceTag/Project': 'orbitary' };
const INFRA = { 'aws:PrincipalArn': `arn:aws:iam::${A}:role/trendigle-shukka-infra` };
const stack = (name) => `arn:aws:cloudformation:${R}:${A}:stack/${name}/0a1b2c3d-1111-2222-3333-444455556666`;
const DIFF = { 'aws:PrincipalArn': `arn:aws:iam::${A}:role/trendigle-shukka-diff` };
const APP = { 'aws:PrincipalArn': `arn:aws:iam::${A}:role/trendigle-shukka-app` };
const SERVER = { 'aws:PrincipalArn': `arn:aws:iam::${A}:role/Trendigle-prod-Instance-Role0EXAMPLE-AbCdEfGhIjKl` };

// [who, expected, action, resource, context]
const cases = [
  ['exec', 'allowed', 'dynamodb:CreateTable', `arn:aws:dynamodb:${R}:${A}:table/trendigle_prod_login_attempts`],
  ['exec', 'allowed', 'dynamodb:UpdateTimeToLive', `arn:aws:dynamodb:${R}:${A}:table/trendigle_prod_login_attempts`],
  ['exec', 'allowed', 'dynamodb:DeleteTable', `arn:aws:dynamodb:${R}:${A}:table/trendigle-prod`],
  ['exec', 'allowed', 's3:PutBucketPolicy', `arn:aws:s3:::trendigle-prod-deploy-${A}`],
  ['exec', 'allowed', 's3:PutLifecycleConfiguration', `arn:aws:s3:::trendigle-prod-media-${A}`],
  ['exec', 'allowed', 'iam:CreateRole', `arn:aws:iam::${A}:role/Trendigle-prod-Instance-Role0EXAMPLE-AbCdEfGhIjKl`, { 'iam:PermissionsBoundary': BOUNDARY }],
  ['exec', 'allowed', 'iam:PutRolePolicy', `arn:aws:iam::${A}:role/Trendigle-prod-Instance-Role0EXAMPLE-AbCdEfGhIjKl`, { 'iam:PermissionsBoundary': BOUNDARY }],
  ['exec', 'allowed', 'iam:PutRolePermissionsBoundary', `arn:aws:iam::${A}:role/trendigle-prod-github-deploy`, { 'iam:PermissionsBoundary': BOUNDARY }],
  ['exec', 'allowed', 'iam:PassRole', `arn:aws:iam::${A}:role/Trendigle-prod-Instance-Role0EXAMPLE-AbCdEfGhIjKl`, { 'iam:PassedToService': 'ec2.amazonaws.com' }],
  ['exec', 'allowed', 'iam:AddRoleToInstanceProfile', `arn:aws:iam::${A}:instance-profile/Trendigle-prod-Instance-BoxInstanceProfile0EXAMPLE-MnOpQrStUvWx`],
  ['exec', 'allowed', 'ec2:ModifyInstanceAttribute', `arn:aws:ec2:${R}:${A}:instance/i-0123456789abcdef0`, T],
  ['exec', 'allowed', 'ec2:RunInstances', `arn:aws:ec2:${R}:${A}:instance/*`, { 'aws:RequestTag/Project': 'trendigle' }],
  ['exec', 'allowed', 'ec2:AuthorizeSecurityGroupIngress', `arn:aws:ec2:${R}:${A}:security-group/sg-0123456789abcdef0`, T],
  ['exec', 'allowed', 'route53:ChangeResourceRecordSets', 'arn:aws:route53:::hostedzone/Z0123456789EXAMPLE'],
  ['exec', 'allowed', 'lambda:CreateFunction', `arn:aws:lambda:${R}:${A}:function:Trendigle-prod-Notify-Worker`],
  ['exec', 'allowed', 'sqs:CreateQueue', `arn:aws:sqs:${R}:${A}:trendigle-prod-events`],
  ['exec', 'allowed', 'ssm:GetParameter', `arn:aws:ssm:${R}:${A}:parameter/cdk-bootstrap/trendigle/version`],
  ['exec', 'implicitDeny', 'dynamodb:DeleteTable', `arn:aws:dynamodb:${R}:${A}:table/orbitary-prod-entities`],
  ['exec', 'implicitDeny', 's3:DeleteBucket', `arn:aws:s3:::orbitary-prod-media-${A}`],
  ['exec', 'implicitDeny', 'iam:UpdateAssumeRolePolicy', `arn:aws:iam::${A}:role/Orbitary-prod-Instance-OrbitaryRole0EXAMPLE-YzAbCdEfGhIj`],
  ['exec', 'implicitDeny', 'iam:CreateRole', `arn:aws:iam::${A}:role/trendigle-escape`],
  ['exec', 'implicitDeny', 'iam:CreateRole', `arn:aws:iam::${A}:role/trendigle-escape`, { 'iam:PermissionsBoundary': `arn:aws:iam::${A}:policy/other` }],
  ['exec', 'explicitDeny', 'iam:DeleteRolePermissionsBoundary', `arn:aws:iam::${A}:role/Trendigle-prod-Instance-Role0EXAMPLE-AbCdEfGhIjKl`],
  ['exec', 'explicitDeny', 'iam:CreatePolicyVersion', BOUNDARY],
  ['exec', 'implicitDeny', 'iam:PassRole', `arn:aws:iam::${A}:role/Orbitary-prod-Instance-OrbitaryRole0EXAMPLE-YzAbCdEfGhIj`, { 'iam:PassedToService': 'ec2.amazonaws.com' }],
  ['exec', 'implicitDeny', 'ec2:TerminateInstances', `arn:aws:ec2:${R}:${A}:instance/i-0orbitary`, O],
  ['exec', 'implicitDeny', 'ec2:RunInstances', `arn:aws:ec2:${R}:${A}:instance/*`, { 'aws:RequestTag/Project': 'orbitary' }],
  ['exec', 'implicitDeny', 'route53:ChangeResourceRecordSets', 'arn:aws:route53:::hostedzone/ZOTHERZONE'],
  ['exec', 'implicitDeny', 'iam:CreateOpenIDConnectProvider', `arn:aws:iam::${A}:oidc-provider/token.actions.githubusercontent.com`],
  ['exec', 'implicitDeny', 'iam:AttachRolePolicy', `arn:aws:iam::${A}:role/trendigle-x`],
  // shu-9bj.6: the pipeline's own roles cannot be re-trusted or given more power through a deploy; other project
  // roles still can be (inside the boundary).
  ['exec', 'explicitDeny', 'iam:UpdateAssumeRolePolicy', `arn:aws:iam::${A}:role/trendigle-shukka-infra`],
  ['exec', 'explicitDeny', 'iam:UpdateAssumeRolePolicy', `arn:aws:iam::${A}:role/trendigle-shukka-app`],
  ['exec', 'explicitDeny', 'iam:DeleteRole', `arn:aws:iam::${A}:role/trendigle-shukka-diff`],
  ['exec', 'explicitDeny', 'iam:PutRolePolicy', `arn:aws:iam::${A}:role/trendigle-shukka-infra`, { 'iam:PermissionsBoundary': BOUNDARY }],
  ['exec', 'explicitDeny', 'iam:AttachRolePolicy', `arn:aws:iam::${A}:role/trendigle-shukka-app`, { 'iam:PermissionsBoundary': BOUNDARY }],
  ['exec', 'explicitDeny', 'iam:DetachRolePolicy', `arn:aws:iam::${A}:role/trendigle-shukka-infra`],
  ['exec', 'explicitDeny', 'iam:DeleteRolePolicy', `arn:aws:iam::${A}:role/Trendigle-shukka-infra`],
  // shu-9bj.12: NoChangeToCiRoles stays as it is, so the execution role cannot give the CI roles their inline policies
  // even while creating them (CreateRole then PutRolePolicy): the CI stack is deployed by hand with the admin's own
  // credentials (shukkaCiSynthesizer), never through the execution role.
  ['exec', 'explicitDeny', 'iam:PutRolePolicy', `arn:aws:iam::${A}:role/trendigle-shukka-app`, { 'iam:PermissionsBoundary': BOUNDARY }],
  ['exec', 'explicitDeny', 'iam:PutRolePolicy', `arn:aws:iam::${A}:role/trendigle-shukka-diff`, { 'iam:PermissionsBoundary': BOUNDARY }],
  ['exec', 'allowed', 'iam:UpdateAssumeRolePolicy', `arn:aws:iam::${A}:role/Trendigle-prod-Instance-Role1ABCC5F0-5uGLbHErVSKT`],
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
  // Changed from the spike: the instance carries the Project tag (instance-scoped agent calls now need it).
  ['bounded', 'allowed', 'ssm:UpdateInstanceInformation', `arn:aws:ec2:${R}:${A}:instance/i-0123456789abcdef0`, T],
  ['bounded', 'allowed', 'ec2messages:GetMessages', '*'],
  ['bounded', 'allowed', 'ssm:SendCommand', `arn:aws:ssm:${R}::document/AWS-RunShellScript`],
  ['bounded', 'allowed', 'ssm:SendCommand', `arn:aws:ec2:${R}:${A}:instance/i-0123456789abcdef0`, T],
  // Changed from the spike: the caller is the pipeline's infra role (only it may assume bootstrap roles now).
  ['bounded', 'allowed', 'sts:AssumeRole', `arn:aws:iam::${A}:role/cdk-trendigle-deploy-role-${A}-${R}`, INFRA],
  ['bounded', 'allowed', 'ses:SendRawEmail', `arn:aws:ses:${R}:${A}:identity/mail.trendigle.com`, { 'ses:FromAddress': 'no-reply@mail.trendigle.com' }],
  ['bounded', 'allowed', 'sqs:SendMessage', `arn:aws:sqs:${R}:${A}:trendigle-prod-events`],
  ['bounded', 'implicitDeny', 'dynamodb:Scan', `arn:aws:dynamodb:${R}:${A}:table/orbitary-prod-entities`],
  ['bounded', 'implicitDeny', 's3:GetObject', `arn:aws:s3:::orbitary-prod-media-${A}/x`],
  ['bounded', 'implicitDeny', 'ssm:GetParameter', `arn:aws:ssm:${R}:${A}:parameter/orbitary/prod/SECRET`],
  ['bounded', 'implicitDeny', 'ssm:SendCommand', `arn:aws:ec2:${R}:${A}:instance/i-0orbitary`, O],
  ['bounded', 'implicitDeny', 'iam:CreateRole', `arn:aws:iam::${A}:role/trendigle-x`],
  ['bounded', 'implicitDeny', 'iam:PutRolePolicy', `arn:aws:iam::${A}:role/Trendigle-prod-Instance-Role0EXAMPLE-AbCdEfGhIjKl`],
  ['bounded', 'implicitDeny', 'ec2:RunInstances', `arn:aws:ec2:${R}:${A}:instance/*`],
  ['bounded', 'implicitDeny', 'sts:AssumeRole', `arn:aws:iam::${A}:role/cdk-hnb659fds-deploy-role-${A}-${R}`],
  ['bounded', 'implicitDeny', 'iam:CreateOpenIDConnectProvider', `arn:aws:iam::${A}:oidc-provider/token.actions.githubusercontent.com`],
  ['bounded', 'implicitDeny', 'ses:SendRawEmail', `arn:aws:ses:${R}:${A}:identity/mail.trendigle.com`, { 'ses:FromAddress': 'x@evil.example' }],
];
// Holes the spike left, each closed by the construct (the spike's documents allow or mis-scope every one of these).
const extra = [
  // Finding 4: an instance without a Project tag, and another document.
  ['bounded', 'implicitDeny', 'ssm:SendCommand', `arn:aws:ec2:${R}:${A}:instance/i-0untagged`],
  ['bounded', 'implicitDeny', 'ssm:SendCommand', `arn:aws:ssm:${R}::document/AWS-RunPowerShellScript`],
  // 1. Bootstrap roles: only the infra role, only deploy and file-publishing.
  ['bounded', 'allowed', 'sts:AssumeRole', `arn:aws:iam::${A}:role/cdk-trendigle-file-publishing-role-${A}-${R}`, INFRA],
  ['bounded', 'implicitDeny', 'sts:AssumeRole', `arn:aws:iam::${A}:role/cdk-trendigle-deploy-role-${A}-${R}`, SERVER],
  ['bounded', 'implicitDeny', 'sts:AssumeRole', `arn:aws:iam::${A}:role/cdk-trendigle-deploy-role-${A}-${R}`],
  ['bounded', 'implicitDeny', 'sts:AssumeRole', `arn:aws:iam::${A}:role/cdk-trendigle-lookup-role-${A}-${R}`, INFRA],
  // 2. Agent calls: logs only to project log groups; instance calls only on own instances; named documents.
  ['bounded', 'allowed', 'logs:PutLogEvents', `arn:aws:logs:${R}:${A}:log-group:trendigle-app:log-stream:x`],
  ['bounded', 'implicitDeny', 'logs:PutLogEvents', `arn:aws:logs:${R}:${A}:log-group:orbitary-app:log-stream:x`],
  ['bounded', 'implicitDeny', 'logs:CreateLogGroup', `arn:aws:logs:${R}:${A}:log-group:orbitary-app`],
  ['bounded', 'implicitDeny', 'ssm:UpdateInstanceInformation', `arn:aws:ec2:${R}:${A}:instance/i-0orbitary`, O],
  ['bounded', 'implicitDeny', 'ssm:PutComplianceItems', `arn:aws:ec2:${R}:${A}:instance/i-0untagged`],
  ['bounded', 'allowed', 'ssm:GetDocument', `arn:aws:ssm:${R}::document/AWS-RunShellScript`],
  ['bounded', 'implicitDeny', 'ssm:GetDocument', `arn:aws:ssm:${R}:${A}:document/orbitary-setup`],
  // 3. Event source mappings only for the project's functions.
  ['exec', 'allowed', 'lambda:CreateEventSourceMapping', '*', { 'lambda:FunctionArn': `arn:aws:lambda:${R}:${A}:function:Trendigle-prod-Notify-Worker` }],
  ['exec', 'implicitDeny', 'lambda:CreateEventSourceMapping', '*', { 'lambda:FunctionArn': `arn:aws:lambda:${R}:${A}:function:orbitary-worker` }],
  ['exec', 'implicitDeny', 'lambda:DeleteEventSourceMapping', `arn:aws:lambda:${R}:${A}:event-source-mapping:0b4c9a2e-1111-2222-3333-444455556666`, { 'lambda:FunctionArn': `arn:aws:lambda:${R}:${A}:function:orbitary-worker` }],
  // 4. No secrets out of other projects' instances.
  ['exec', 'implicitDeny', 'ec2:GetPasswordData', `arn:aws:ec2:${R}:${A}:instance/i-0orbitary`, O],
  ['exec', 'implicitDeny', 'ec2:GetConsoleOutput', `arn:aws:ec2:${R}:${A}:instance/i-0orbitary`, O],
  ['exec', 'implicitDeny', 'ec2:GetConsoleScreenshot', `arn:aws:ec2:${R}:${A}:instance/i-0orbitary`, O],
  // 5. Elastic IPs and network interfaces need the Project tag.
  ['exec', 'implicitDeny', 'ec2:AssociateAddress', `arn:aws:ec2:${R}:${A}:elastic-ip/eipalloc-0untagged`],
  ['exec', 'implicitDeny', 'ec2:AssociateAddress', `arn:aws:ec2:${R}:${A}:network-interface/eni-0orbitary`, O],
  ['exec', 'allowed', 'ec2:AssociateAddress', `arn:aws:ec2:${R}:${A}:elastic-ip/eipalloc-0trendigle`, T],
  // 6. AMIs by owner; security groups and snapshots only the project's.
  ['exec', 'allowed', 'ec2:RunInstances', `arn:aws:ec2:${R}::image/ami-0abc`, { 'ec2:Owner': 'amazon' }],
  ['exec', 'implicitDeny', 'ec2:RunInstances', `arn:aws:ec2:${R}::image/ami-0abc`, { 'ec2:Owner': '210987654321' }],
  ['exec', 'allowed', 'ec2:RunInstances', `arn:aws:ec2:${R}:${A}:security-group/sg-0trendigle`, T],
  ['exec', 'implicitDeny', 'ec2:RunInstances', `arn:aws:ec2:${R}:${A}:security-group/sg-0orbitary`, { ...O, 'aws:RequestTag/Project': 'trendigle' }],
  ['exec', 'implicitDeny', 'ec2:CreateVolume', `arn:aws:ec2:${R}::snapshot/snap-0orbitary`, { ...O, 'aws:RequestTag/Project': 'trendigle' }],
  ['exec', 'allowed', 'ec2:CreateVolume', `arn:aws:ec2:${R}::snapshot/snap-0trendigle`, T],
  ['exec', 'allowed', 'ec2:CreateSecurityGroup', `arn:aws:ec2:${R}:${A}:vpc/vpc-0abc`],
  // 7. The Project tag can only be the project's, and cannot be removed.
  ['exec', 'explicitDeny', 'ec2:CreateTags', `arn:aws:ec2:${R}:${A}:instance/i-0123456789abcdef0`, { ...T, 'aws:TagKeys': ['Project'], 'aws:RequestTag/Project': 'orbitary' }],
  ['exec', 'explicitDeny', 'ec2:DeleteTags', `arn:aws:ec2:${R}:${A}:instance/i-0123456789abcdef0`, { ...T, 'aws:TagKeys': ['Project'] }],
  ['exec', 'allowed', 'ec2:CreateTags', `arn:aws:ec2:${R}:${A}:instance/i-0123456789abcdef0`, { ...T, 'aws:TagKeys': ['Project'], 'aws:RequestTag/Project': 'trendigle' }],
  ['exec', 'allowed', 'ec2:CreateTags', `arn:aws:ec2:${R}:${A}:instance/i-0123456789abcdef0`, { ...T, 'aws:TagKeys': ['Name'], 'aws:RequestTag/Name': 'box' }],
  // 8. The second and third execution policies cannot be rewritten.
  ['exec', 'explicitDeny', 'iam:CreatePolicyVersion', `arn:aws:iam::${A}:policy/trendigle-shukka-execution-infra`],
  ['exec', 'explicitDeny', 'iam:CreatePolicyVersion', `arn:aws:iam::${A}:policy/trendigle-shukka-execution-iam`],
  // 9. No user data from other projects' instances (DescribeInstanceAttribute), nor from spot requests.
  ['exec', 'explicitDeny', 'ec2:DescribeInstanceAttribute', `arn:aws:ec2:${R}:${A}:instance/i-0orbitary`, O],
  ['exec', 'explicitDeny', 'ec2:DescribeInstanceAttribute', `arn:aws:ec2:${R}:${A}:instance/i-0untagged`],
  ['exec', 'allowed', 'ec2:DescribeInstanceAttribute', `arn:aws:ec2:${R}:${A}:instance/i-0123456789abcdef0`, T],
  ['exec', 'explicitDeny', 'ec2:DescribeSpotInstanceRequests', '*'],
  ['exec', 'allowed', 'ec2:DescribeInstances', '*'],
  // 10. RunInstances: launch templates only the project's; existing network interfaces only the project's.
  ['exec', 'implicitDeny', 'ec2:RunInstances', `arn:aws:ec2:${R}:${A}:launch-template/lt-0orbitary`, O],
  ['exec', 'allowed', 'ec2:RunInstances', `arn:aws:ec2:${R}:${A}:launch-template/lt-0trendigle`, T],
  ['exec', 'implicitDeny', 'ec2:RunInstances', `arn:aws:ec2:${R}:${A}:network-interface/eni-0orbitary`, O],
  ['exec', 'allowed', 'ec2:RunInstances', `arn:aws:ec2:${R}:${A}:network-interface/*`],
  // 11. shu-9bj.9: listing the account's instances and reading any command's output only for the app role, never
  // servers, Lambdas or another project's app role.
  ['bounded', 'allowed', 'ec2:DescribeInstances', '*', APP],
  ['bounded', 'allowed', 'ssm:GetCommandInvocation', '*', APP],
  ['bounded', 'implicitDeny', 'ec2:DescribeInstances', '*', SERVER],
  ['bounded', 'implicitDeny', 'ssm:GetCommandInvocation', '*', SERVER],
  ['bounded', 'implicitDeny', 'ec2:DescribeInstances', '*'],
  ['bounded', 'implicitDeny', 'ssm:GetCommandInvocation', '*', { 'aws:PrincipalArn': `arn:aws:iam::${A}:role/orbitary-shukka-app` }],
  ['bounded', 'implicitDeny', 'ssm:GetCommandInvocation', '*', INFRA],
  // 12. shu-9bj.9: the pipeline roles carry the boundary, so each action ShukkaAccess grants them must pass it.
  // Diff role: its project's templates, stacks and bootstrap version, nobody else's, and no other role.
  ['bounded', 'allowed', 'cloudformation:GetTemplate', stack('Trendigle-prod'), DIFF],
  ['bounded', 'allowed', 'cloudformation:DescribeStacks', stack('trendigle-ci'), DIFF],
  ['bounded', 'allowed', 'ssm:GetParameter', `arn:aws:ssm:${R}:${A}:parameter/cdk-bootstrap/trendigle/version`, DIFF],
  ['bounded', 'implicitDeny', 'cloudformation:GetTemplate', stack('Orbitary-prod-Data'), DIFF],
  ['bounded', 'implicitDeny', 'ssm:GetParameter', `arn:aws:ssm:${R}:${A}:parameter/cdk-bootstrap/orbitary/version`, DIFF],
  ['bounded', 'implicitDeny', 'cloudformation:GetTemplate', stack('Trendigle-prod'), SERVER],
  ['bounded', 'implicitDeny', 'cloudformation:DescribeStacks', stack('Trendigle-prod'), APP],
  // Infra role: the project's deploy and file-publishing roles.
  ['bounded', 'allowed', 'sts:AssumeRole', `arn:aws:iam::${A}:role/cdk-trendigle-deploy-role-${A}-${R}`, INFRA],
  ['bounded', 'allowed', 'sts:AssumeRole', `arn:aws:iam::${A}:role/cdk-trendigle-file-publishing-role-${A}-${R}`, INFRA],
  // App role: upload, run on its tagged servers, wait for agents, find instances, read results.
  ['bounded', 'allowed', 's3:PutObject', `arn:aws:s3:::trendigle-prod-deploy-${A}/trendigle/app/abc.tgz`, APP],
  ['bounded', 'allowed', 'ssm:SendCommand', `arn:aws:ssm:${R}::document/AWS-RunShellScript`, APP],
  ['bounded', 'allowed', 'ssm:SendCommand', `arn:aws:ec2:${R}:${A}:instance/i-0123456789abcdef0`, { ...APP, ...T }],
  ['bounded', 'allowed', 'ssm:DescribeInstanceInformation', '*', APP],
  // A deploy bucket not named for the project is outside the fence (shukka.json refuses it).
  ['bounded', 'implicitDeny', 's3:PutObject', `arn:aws:s3:::shared-deploy-${A}/trendigle/app/abc.tgz`, APP],
  // shu-9bj.6: no bounded role (server, Lambda, custom resource) writes a resource policy or sends data out after the
  // policy guard read the templates; ordinary use of the same resources stays allowed.
  ['bounded', 'explicitDeny', 's3:PutBucketPolicy', `arn:aws:s3:::trendigle-prod-media-${A}`],
  ['bounded', 'explicitDeny', 's3:DeleteBucketPolicy', `arn:aws:s3:::trendigle-prod-media-${A}`],
  ['bounded', 'explicitDeny', 's3:PutBucketAcl', `arn:aws:s3:::trendigle-prod-media-${A}`],
  ['bounded', 'explicitDeny', 's3:PutObjectAcl', `arn:aws:s3:::trendigle-prod-media-${A}/x.png`],
  ['bounded', 'explicitDeny', 's3:PutBucketPublicAccessBlock', `arn:aws:s3:::trendigle-prod-media-${A}`],
  ['bounded', 'explicitDeny', 's3:PutBucketOwnershipControls', `arn:aws:s3:::trendigle-prod-media-${A}`],
  ['bounded', 'explicitDeny', 'sqs:AddPermission', `arn:aws:sqs:${R}:${A}:trendigle-prod-events`],
  ['bounded', 'explicitDeny', 'sqs:SetQueueAttributes', `arn:aws:sqs:${R}:${A}:trendigle-prod-events`],
  ['bounded', 'explicitDeny', 'sns:AddPermission', `arn:aws:sns:${R}:${A}:trendigle-prod-alerts`],
  ['bounded', 'explicitDeny', 'sns:SetTopicAttributes', `arn:aws:sns:${R}:${A}:trendigle-prod-alerts`],
  ['bounded', 'explicitDeny', 'sns:Subscribe', `arn:aws:sns:${R}:${A}:trendigle-prod-alerts`],
  ['bounded', 'explicitDeny', 'lambda:AddPermission', `arn:aws:lambda:${R}:${A}:function:Trendigle-prod-Notify-Worker`],
  ['bounded', 'explicitDeny', 'lambda:AddLayerVersionPermission', `arn:aws:lambda:${R}:${A}:layer:trendigle-x:1`],
  ['bounded', 'explicitDeny', 'lambda:CreateFunctionUrlConfig', `arn:aws:lambda:${R}:${A}:function:Trendigle-prod-Notify-Worker`],
  ['bounded', 'explicitDeny', 'lambda:UpdateFunctionUrlConfig', `arn:aws:lambda:${R}:${A}:function:Trendigle-prod-Notify-Worker`],
  ['bounded', 'explicitDeny', 'dynamodb:PutResourcePolicy', `arn:aws:dynamodb:${R}:${A}:table/trendigle_prod_posts`],
  ['bounded', 'explicitDeny', 'logs:PutSubscriptionFilter', `arn:aws:logs:${R}:${A}:log-group:/trendigle/prod/app`],
  ['bounded', 'explicitDeny', 'logs:PutDestinationPolicy', `arn:aws:logs:${R}:${A}:destination:trendigle-x`],
  ['bounded', 'explicitDeny', 'ssm:PutResourcePolicy', `arn:aws:ssm:${R}:${A}:parameter/trendigle/prod/x`],
  ['bounded', 'explicitDeny', 'ssm:DeleteResourcePolicy', `arn:aws:ssm:${R}:${A}:parameter/trendigle/prod/x`],
  ['bounded', 'allowed', 's3:PutObject', `arn:aws:s3:::trendigle-prod-media-${A}/u/x.png`],
  ['bounded', 'allowed', 'sqs:SendMessage', `arn:aws:sqs:${R}:${A}:trendigle-prod-events`],
  ['bounded', 'allowed', 'sns:Publish', `arn:aws:sns:${R}:${A}:trendigle-prod-alerts`],
];

// shu-9bj.2: the project's bootstrap (lib/bootstrap.ts). The deploy role changes only the project's stacks, and only
// with the project's own execution role; the file-publishing role writes only the project's asset bucket.
const OWN_EXEC = `arn:aws:iam::${A}:role/cdk-trendigle-cfn-exec-role-${A}-${R}`;
const ROLE = (arn) => ({ 'cloudformation:RoleArn': arn });
const OWN = ROLE(OWN_EXEC);
const bootstrap = [
  ['deploy', 'allowed', 'cloudformation:CreateChangeSet', stack('Trendigle-prod'), OWN],
  ['deploy', 'allowed', 'cloudformation:CreateChangeSet', stack('trendigle-ci'), OWN],
  ['deploy', 'allowed', 'cloudformation:ExecuteChangeSet', stack('Trendigle-prod')],
  ['deploy', 'allowed', 'cloudformation:DescribeStacks', stack('Trendigle-prod')],
  ['deploy', 'allowed', 'cloudformation:GetTemplate', stack('Trendigle-prod')],
  ['deploy', 'allowed', 'cloudformation:DeleteStack', stack('Trendigle-prod'), OWN],
  ['deploy', 'allowed', 'iam:PassRole', OWN_EXEC, { 'iam:PassedToService': 'cloudformation.amazonaws.com' }],
  ['deploy', 'allowed', 'ssm:GetParameter', `arn:aws:ssm:${R}:${A}:parameter/cdk-bootstrap/trendigle/version`],
  ['deploy', 'allowed', 's3:GetObject', `arn:aws:s3:::cdk-trendigle-assets-${A}-${R}/abc.json`],
  // Own stack, but no RoleArn (CloudFormation would reuse the stored role) or another role.
  ['deploy', 'explicitDeny', 'cloudformation:CreateChangeSet', stack('Trendigle-prod')],
  ['deploy', 'explicitDeny', 'cloudformation:CreateChangeSet', stack('Trendigle-prod'), ROLE(`arn:aws:iam::${A}:role/cdk-hnb659fds-cfn-exec-role-${A}-${R}`)],
  ['deploy', 'explicitDeny', 'cloudformation:CreateChangeSet', stack('Trendigle-prod'), ROLE(`arn:aws:iam::${A}:role/cdk-orbitary-cfn-exec-role-${A}-${R}`)],
  ['deploy', 'explicitDeny', 'cloudformation:UpdateStack', stack('Trendigle-prod')],
  ['deploy', 'explicitDeny', 'cloudformation:DeleteStack', stack('Trendigle-prod')],
  // Other stacks, even with the project's own execution role.
  ['deploy', 'implicitDeny', 'cloudformation:CreateChangeSet', stack('Orbitary-prod-Data'), OWN],
  ['deploy', 'implicitDeny', 'cloudformation:CreateChangeSet', stack('orbitary-ci'), OWN],
  ['deploy', 'implicitDeny', 'cloudformation:CreateChangeSet', stack('Shukka-Account'), OWN],
  ['deploy', 'implicitDeny', 'cloudformation:CreateChangeSet', stack(boundaryStackName('trendigle')), OWN],
  ['deploy', 'implicitDeny', 'cloudformation:CreateChangeSet', stack(bootstrapStackName('trendigle')), OWN],
  ['deploy', 'implicitDeny', 'cloudformation:CreateChangeSet', stack('CDKToolkit'), OWN],
  ['deploy', 'implicitDeny', 'cloudformation:CreateChangeSet', stack('Trendiglex-prod'), OWN],
  ['deploy', 'implicitDeny', 'cloudformation:ExecuteChangeSet', stack('Orbitary-prod-Data')],
  ['deploy', 'implicitDeny', 'cloudformation:DeleteStack', stack('Shukka-Account'), OWN],
  ['deploy', 'implicitDeny', 'cloudformation:DescribeStacks', stack('Orbitary-prod-Data')],
  ['deploy', 'explicitDeny', 'cloudformation:CreateChangeSet', stack('Orbitary-prod-Data'), ROLE(`arn:aws:iam::${A}:role/cdk-hnb659fds-cfn-exec-role-${A}-${R}`)],
  ['deploy', 'implicitDeny', 'iam:PassRole', `arn:aws:iam::${A}:role/cdk-hnb659fds-cfn-exec-role-${A}-${R}`, { 'iam:PassedToService': 'cloudformation.amazonaws.com' }],
  ['deploy', 'implicitDeny', 'iam:PassRole', OWN_EXEC, { 'iam:PassedToService': 'ec2.amazonaws.com' }],
  ['deploy', 'implicitDeny', 's3:PutObject', `arn:aws:s3:::cdk-trendigle-assets-${A}-${R}/abc.json`],
  ['deploy', 'implicitDeny', 'ssm:GetParameter', `arn:aws:ssm:${R}:${A}:parameter/orbitary/prod/SECRET`],
  ['publish', 'allowed', 's3:PutObject', `arn:aws:s3:::cdk-trendigle-assets-${A}-${R}/abc.zip`, { 'aws:ResourceAccount': A }],
  ['publish', 'allowed', 's3:ListBucket', `arn:aws:s3:::cdk-trendigle-assets-${A}-${R}`, { 'aws:ResourceAccount': A }],
  ['publish', 'implicitDeny', 's3:PutObject', `arn:aws:s3:::cdk-hnb659fds-assets-${A}-${R}/abc.zip`, { 'aws:ResourceAccount': A }],
  ['publish', 'implicitDeny', 's3:PutObject', `arn:aws:s3:::cdk-orbitary-assets-${A}-${R}/abc.zip`, { 'aws:ResourceAccount': A }],
  ['publish', 'implicitDeny', 's3:DeleteObject', `arn:aws:s3:::cdk-trendigle-assets-${A}-${R}/abc.zip`, { 'aws:ResourceAccount': A }],
  ['publish', 'implicitDeny', 's3:PutBucketPolicy', `arn:aws:s3:::cdk-trendigle-assets-${A}-${R}`, { 'aws:ResourceAccount': A }],
  // Review follow-up: the execution role reads Lambda code from its own asset bucket only.
  ['exec', 'allowed', 's3:GetObject', `arn:aws:s3:::cdk-trendigle-assets-${A}-${R}/abc.zip`],
  ['exec', 'allowed', 's3:GetObjectVersion', `arn:aws:s3:::cdk-trendigle-assets-${A}-${R}/abc.zip`],
  ['exec', 'implicitDeny', 's3:GetObject', `arn:aws:s3:::cdk-hnb659fds-assets-${A}-${R}/abc.zip`],
  ['exec', 'implicitDeny', 's3:GetObject', `arn:aws:s3:::cdk-orbitary-assets-${A}-${R}/abc.zip`],
  ['exec', 'implicitDeny', 's3:GetObject', `arn:aws:s3:::cdk-trendiglex-assets-${A}-${R}/abc.zip`],
  ['exec', 'implicitDeny', 's3:PutObject', `arn:aws:s3:::cdk-trendigle-assets-${A}-${R}/abc.zip`],
  // Security access-3: who may assume the deploy and file-publishing roles (trust condition; see bootstrap.ts).
  ['deployTrust', 'allowed', 'sts:AssumeRole', `arn:aws:iam::${A}:role/cdk-trendigle-deploy-role-${A}-${R}`, INFRA],
  ['deployTrust', 'implicitDeny', 'sts:AssumeRole', `arn:aws:iam::${A}:role/cdk-trendigle-deploy-role-${A}-${R}`, SERVER],
  ['deployTrust', 'implicitDeny', 'sts:AssumeRole', `arn:aws:iam::${A}:role/cdk-trendigle-deploy-role-${A}-${R}`, { 'aws:PrincipalArn': `arn:aws:iam::${A}:role/orbitary-shukka-infra` }],
  ['deployTrust', 'implicitDeny', 'sts:AssumeRole', `arn:aws:iam::${A}:role/cdk-trendigle-deploy-role-${A}-${R}`, { 'aws:PrincipalArn': SSO_ADMIN.replace('*', 'abc123') }],
  ['publishTrust', 'allowed', 'sts:AssumeRole', `arn:aws:iam::${A}:role/cdk-trendigle-file-publishing-role-${A}-${R}`, INFRA],
  ['publishTrust', 'implicitDeny', 'sts:AssumeRole', `arn:aws:iam::${A}:role/cdk-trendigle-file-publishing-role-${A}-${R}`, SERVER],
  ['deployTrustAdmin', 'allowed', 'sts:AssumeRole', `arn:aws:iam::${A}:role/cdk-trendigle-deploy-role-${A}-${R}`, { 'aws:PrincipalArn': SSO_ADMIN.replace('*', 'abc123') }],
  ['deployTrustAdmin', 'allowed', 'sts:AssumeRole', `arn:aws:iam::${A}:role/cdk-trendigle-deploy-role-${A}-${R}`, INFRA],
  ['deployTrustAdmin', 'implicitDeny', 'sts:AssumeRole', `arn:aws:iam::${A}:role/cdk-trendigle-deploy-role-${A}-${R}`, { 'aws:PrincipalArn': `arn:aws:iam::${A}:role/aws-reserved/sso.amazonaws.com/AWSReservedSSO_ReadOnly_x` }],
];

// shu-9bj.4: a deploy-role session (`shukka deploy` from a laptop) may assume its own file-publishing role, and not
// another qualifier's: the deploy role's identity policy names only its own, and the file-publishing role's trust
// names only its own deploy role. The deploy role's own trust does not change.
const DEPLOY_ROLE = (q) => ({ 'aws:PrincipalArn': `arn:aws:iam::${A}:role/cdk-${q}-deploy-role-${A}-${R}` });
const PUBLISH_ROLE = (q) => `arn:aws:iam::${A}:role/cdk-${q}-file-publishing-role-${A}-${R}`;
const deployPublishes = [
  ['deploy', 'allowed', 'sts:AssumeRole', PUBLISH_ROLE('trendigle')],
  ['deploy', 'allowed', 'sts:TagSession', PUBLISH_ROLE('trendigle')],
  ['deploy', 'implicitDeny', 'sts:AssumeRole', PUBLISH_ROLE('orbitary')],
  ['deploy', 'implicitDeny', 'sts:AssumeRole', PUBLISH_ROLE('hnb659fds')],
  ['deploy', 'implicitDeny', 'sts:AssumeRole', PUBLISH_ROLE('trendiglex')],
  ['deploy', 'implicitDeny', 'sts:AssumeRole', `arn:aws:iam::${A}:role/cdk-trendigle-deploy-role-${A}-${R}`],
  ['deploy', 'implicitDeny', 'sts:AssumeRole', `arn:aws:iam::${A}:role/cdk-trendigle-cfn-exec-role-${A}-${R}`],
  ['publishTrust', 'allowed', 'sts:AssumeRole', PUBLISH_ROLE('trendigle'), DEPLOY_ROLE('trendigle')],
  ['publishTrust', 'implicitDeny', 'sts:AssumeRole', PUBLISH_ROLE('trendigle'), DEPLOY_ROLE('orbitary')],
  ['publishTrust', 'implicitDeny', 'sts:AssumeRole', PUBLISH_ROLE('trendigle'), DEPLOY_ROLE('hnb659fds')],
  ['publishTrust', 'implicitDeny', 'sts:AssumeRole', PUBLISH_ROLE('trendigle'), DEPLOY_ROLE('trendiglex')],
  ['publishTrust', 'implicitDeny', 'sts:AssumeRole', PUBLISH_ROLE('trendigle'), { 'aws:PrincipalArn': `arn:aws:iam::${A}:role/cdk-trendigle-cfn-exec-role-${A}-${R}` }],
  // Another qualifier's file-publishing role does not trust this project's deploy role.
  ['publishTrustOther', 'allowed', 'sts:AssumeRole', PUBLISH_ROLE('tq'), DEPLOY_ROLE('tq')],
  ['publishTrustOther', 'implicitDeny', 'sts:AssumeRole', PUBLISH_ROLE('tq'), DEPLOY_ROLE('trendigle')],
  ['publishTrustAdmin', 'allowed', 'sts:AssumeRole', PUBLISH_ROLE('trendigle'), DEPLOY_ROLE('trendigle')],
  ['publishTrustAdmin', 'allowed', 'sts:AssumeRole', PUBLISH_ROLE('trendigle'), { 'aws:PrincipalArn': SSO_ADMIN.replace('*', 'abc123') }],
  // The deploy role still may not assume itself (its trust is unchanged).
  ['deployTrust', 'implicitDeny', 'sts:AssumeRole', `arn:aws:iam::${A}:role/cdk-trendigle-deploy-role-${A}-${R}`, DEPLOY_ROLE('trendigle')],
];

const POLICIES = {
  exec: EX, bounded: [ALLOW_ALL], deploy: [boot.deploy], publish: [boot.filePublishing],
  deployTrust: [boot.deployTrust], publishTrust: [boot.filePublishingTrust], deployTrustAdmin: [bootAdmin.deployTrust],
  publishTrustOther: [bootOther.filePublishingTrust], publishTrustAdmin: [bootAdmin.filePublishingTrust],
};

async function simulate([who, , action, resource, ctx]) {
  const policies = POLICIES[who];
  const args = ['iam', 'simulate-custom-policy', '--policy-input-list', ...policies.map((p) => JSON.stringify(p)),
    '--action-names', action, '--resource-arns', resource, '--output', 'json'];
  if (who === 'bounded') args.push('--permissions-boundary-policy-input-list', JSON.stringify(d.boundary));
  if (ctx) {
    const entries = Object.entries(ctx).map(([k, v]) => Array.isArray(v)
      ? { ContextKeyName: k, ContextKeyValues: v, ContextKeyType: 'stringList' }
      : { ContextKeyName: k, ContextKeyValues: [v], ContextKeyType: 'string' });
    args.push('--context-entries', JSON.stringify(entries));
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
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${who.padEnd(16)} ${action.padEnd(38)} ${resource.split(':').pop().slice(0, 60).padEnd(60)} ${got[i]}${pass ? '' : ` (want ${want})`}`);
  });
  console.log(`${title}: ${ok} ok of ${list.length}\n`);
}

await report('spike S2 cases', cases);
await report('spike holes closed', extra);
await report('project bootstrap (shu-9bj.2)', bootstrap);
await report('deploy role publishes file assets (shu-9bj.4)', deployPublishes);
process.exit(failed ? 1 : 0);
