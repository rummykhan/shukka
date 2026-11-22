// The per-project fence (design D5, spike S2): a permissions boundary for every role the project's stacks create,
// and the execution policy of the project's CloudFormation execution role, split in three managed policies
// (data and services, EC2, IAM) because a managed policy holds at most 6,144 characters. A port of docs/factory/v1/spikes/s2/policy.py. Where the spike
// left a hole, the statement differs from the spike and says so ("Spike hole:"); test/fence.test.ts lists each
// difference and test/simulate/run.mjs has a case proving the hole is closed.
//
// The fence is a name prefix: resources must be named `<project>*` or `<Project>*`. Project names in one account
// must therefore not be prefixes of one another.
//
// Statements with Resource "*" are of three kinds, and each says which in a comment:
// - actions with no resource type (nothing narrower than "*" can be written);
// - actions whose resource does not exist yet or has no project name, fenced instead by a condition on a tag, the
//   function, the calling service or the From address;
// - denies, which only take away.
import { Aspects, Aws, CfnResource, Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct, type IConstruct } from 'constructs';

export interface FenceInputs {
  /** The project name from shukka.json: `^[a-z][a-z0-9-]{1,20}$`, not a prefix of another project in the account. */
  readonly project: string;
  readonly account: string;
  readonly region: string;
  /** The project's CDK bootstrap qualifier: `^[a-z0-9]{1,10}$`. */
  readonly qualifier: string;
  /** The Route 53 hosted zone the project may change, by id. */
  readonly hostedZoneId: string;
  /** SES identities (domains) the project owns and may send mail from. No wildcards. */
  readonly sesDomains: readonly string[];
  /** Owners whose AMIs the project's instances may launch from (`ec2:Owner`). Default `['amazon']`. */
  readonly amiOwners?: readonly string[];
}

export interface PolicyStatementJson {
  Sid: string;
  Effect: 'Allow' | 'Deny';
  Action: string | string[];
  Resource: string | string[];
  Condition?: Record<string, Record<string, string | string[]>>;
}

export interface PolicyDocumentJson {
  Version: '2012-10-17';
  Statement: PolicyStatementJson[];
}

export interface FenceDocuments {
  /** Execution policy, part one: the project's data and services. */
  readonly executionA: PolicyDocumentJson;
  /** Execution policy, part two: EC2. */
  readonly executionB: PolicyDocumentJson;
  /** Execution policy, part three: IAM (the project's roles and instance profiles, and the boundary's protection). */
  readonly executionC: PolicyDocumentJson;
  /** The permissions boundary on every role the project's stacks create. */
  readonly boundary: PolicyDocumentJson;
}

/** Name of the boundary managed policy; roles created by the project must carry it. */
export function boundaryPolicyName(project: string): string {
  return `${project}-shukka-boundary`;
}

/** Names of the three execution managed policies, in the order `cdk bootstrap` takes them. */
export function executionPolicyNames(project: string): [string, string, string] {
  return [`${project}-shukka-execution`, `${project}-shukka-execution-infra`, `${project}-shukka-execution-iam`];
}

/**
 * Name of the pipeline's infra role (ShukkaAccess creates it). Only this role may assume the project's bootstrap
 * deploy and file-publishing roles.
 */
export function infraRoleName(project: string): string {
  return `${project}-shukka-infra`;
}

const PROJECT_RE = /^[a-z][a-z0-9-]{1,20}$/;
const QUALIFIER_RE = /^[a-z0-9]{1,10}$/;
const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;
const HOSTED_ZONE_RE = /^Z[A-Z0-9]{1,32}$/;
const AMI_OWNER_RE = /^(?:amazon|aws-marketplace|\d{12})$/;

/** Throws when an input would widen or break the fence (a wildcard, a name that is not a plain prefix). */
export function validateFenceInputs(
  inputs: Pick<FenceInputs, 'project' | 'qualifier' | 'sesDomains' | 'amiOwners' | 'hostedZoneId'> & { account?: string },
): void {
  if (!PROJECT_RE.test(inputs.project)) {
    throw new Error(`shukka: project name ${JSON.stringify(inputs.project)} must match ${PROJECT_RE}`);
  }
  if (!QUALIFIER_RE.test(inputs.qualifier)) {
    throw new Error(`shukka: qualifier ${JSON.stringify(inputs.qualifier)} must match ${QUALIFIER_RE}`);
  }
  if (!HOSTED_ZONE_RE.test(inputs.hostedZoneId)) {
    throw new Error(`shukka: hosted zone id ${JSON.stringify(inputs.hostedZoneId)} must match ${HOSTED_ZONE_RE}`);
  }
  for (const d of inputs.sesDomains) {
    if (!DOMAIN_RE.test(d)) throw new Error(`shukka: mail domain ${JSON.stringify(d)} must be a plain domain name, no wildcards`);
  }
  for (const o of inputs.amiOwners ?? []) {
    if (!AMI_OWNER_RE.test(o)) throw new Error(`shukka: AMI owner ${JSON.stringify(o)} must be amazon, aws-marketplace or an account id`);
    // The project's own account is shared with other projects; its private AMIs are not the project's to launch.
    if (o === inputs.account) throw new Error(`shukka: AMI owner ${o} is the stack's own account; private AMIs in a shared account are refused`);
  }
}

const INFRA_SIDS = new Set([
  'EC2Read', 'EC2DescribeOwnInstancesOnly', 'EC2NoSpotRequests', 'EC2RunInstancesInterfaces', 'EC2LaunchTagged', 'EC2CreateTagged', 'EC2RunInstancesSupporting', 'EC2RunInstancesImages', 'EC2UseOwnTagged',
  'EC2TagOnCreate', 'EC2ChangeOwn', 'EC2ProjectTagIsFixed', 'EC2AssociateToOwnInstance',
]);

const IAM_SIDS = new Set(['IAMOwnRoles', 'IAMBoundedWrites', 'IAMPassOwnRoles', 'IAMInstanceProfiles', 'IAMReadOIDC', 'NoEscapeFromBoundary']);

const DATA_SIDS = new Set(['DynamoDB', 'S3', 'Lambda', 'SQS', 'SNS', 'Alarms', 'Logs', 'Parameters']);

/** The fence documents for one project, as plain IAM JSON. Throws on invalid inputs (see validateFenceInputs). */
export function fenceDocuments(inputs: FenceInputs): FenceDocuments {
  const { project: P, account, region, qualifier, hostedZoneId: zone, sesDomains: ses } = inputs;
  const amiOwners = inputs.amiOwners ?? ['amazon'];
  validateFenceInputs({ ...inputs, amiOwners });
  // CDK's generated names start with the stack name, which is capitalised.
  const Pc = P.slice(0, 1).toUpperCase() + P.slice(1);
  const names = [`${P}*`, `${Pc}*`];
  const arns = (fmt: (n: string) => string) => names.map(fmt);
  const boundaryArn = `arn:aws:iam::${account}:policy/${boundaryPolicyName(P)}`;
  const execArns = executionPolicyNames(P).map((n) => `arn:aws:iam::${account}:policy/${n}`);
  const ec2 = (type: string) => `arn:aws:ec2:${region}:${account}:${type}/*`;
  const ownTag = { StringEquals: { 'aws:ResourceTag/Project': P } };

  const tbl = arns((n) => `arn:aws:dynamodb:${region}:${account}:table/${n}`);
  const functions = [...arns((n) => `arn:aws:lambda:${region}:${account}:function:${n}`), ...arns((n) => `arn:aws:lambda:${region}:${account}:function:${n}:*`)];
  const ec2CreateActions = ['RunInstances', 'CreateSecurityGroup', 'CreateLaunchTemplate', 'AllocateAddress', 'CreateVolume'];

  // Everything a project's own resources may have done to them (shared by the execution policy and the boundary).
  const resourceStatements: PolicyStatementJson[] = [
    { Sid: 'DynamoDB', Effect: 'Allow', Action: 'dynamodb:*', Resource: [...tbl, ...tbl.map((t) => `${t}/*`)] },
    { Sid: 'S3', Effect: 'Allow', Action: 's3:*', Resource: [...arns((n) => `arn:aws:s3:::${n}`), ...arns((n) => `arn:aws:s3:::${n}/*`)] },
    { Sid: 'Lambda', Effect: 'Allow', Action: 'lambda:*', Resource: functions },
    // Spike hole: the spike allowed all five event-source-mapping actions on "*", so a mapping could point any
    // project's queue at any function. Resource "*": CreateEventSourceMapping has no resource type, and the mapping
    // ARN of Update/Delete is a UUID; fenced by lambda:FunctionArn to the project's functions.
    {
      Sid: 'LambdaEventSources', Effect: 'Allow',
      Action: ['lambda:CreateEventSourceMapping', 'lambda:UpdateEventSourceMapping', 'lambda:DeleteEventSourceMapping'],
      Resource: '*', Condition: { ArnLike: { 'lambda:FunctionArn': functions } },
    },
    { Sid: 'LambdaEventSourcesRead', Effect: 'Allow', Action: 'lambda:GetEventSourceMapping', Resource: `arn:aws:lambda:${region}:${account}:event-source-mapping:*` },
    // Resource "*": ListEventSourceMappings has no resource type.
    { Sid: 'LambdaEventSourcesList', Effect: 'Allow', Action: 'lambda:ListEventSourceMappings', Resource: '*' },
    { Sid: 'SQS', Effect: 'Allow', Action: 'sqs:*', Resource: arns((n) => `arn:aws:sqs:${region}:${account}:${n}`) },
    { Sid: 'SNS', Effect: 'Allow', Action: 'sns:*', Resource: arns((n) => `arn:aws:sns:${region}:${account}:${n}`) },
    { Sid: 'Alarms', Effect: 'Allow', Action: 'cloudwatch:*', Resource: arns((n) => `arn:aws:cloudwatch:${region}:${account}:alarm:${n}`) },
    {
      Sid: 'Logs', Effect: 'Allow', Action: 'logs:*',
      Resource: [
        ...arns((n) => `arn:aws:logs:${region}:${account}:log-group:${n}`),
        ...arns((n) => `arn:aws:logs:${region}:${account}:log-group:${n}:*`),
        ...arns((n) => `arn:aws:logs:${region}:${account}:log-group:/aws/lambda/${n}`),
        ...arns((n) => `arn:aws:logs:${region}:${account}:log-group:/aws/lambda/${n}:*`),
      ],
    },
    { Sid: 'Parameters', Effect: 'Allow', Action: 'ssm:*', Resource: [`arn:aws:ssm:${region}:${account}:parameter/${P}`, `arn:aws:ssm:${region}:${account}:parameter/${P}/*`] },
    {
      Sid: 'DNS', Effect: 'Allow',
      Action: ['route53:ChangeResourceRecordSets', 'route53:GetHostedZone', 'route53:ListResourceRecordSets', 'route53:ChangeTagsForResource', 'route53:ListTagsForResource'],
      Resource: `arn:aws:route53:::hostedzone/${zone}`,
    },
    { Sid: 'DNSChanges', Effect: 'Allow', Action: ['route53:GetChange'], Resource: 'arn:aws:route53:::change/*' },
    {
      Sid: 'SES', Effect: 'Allow', Action: 'ses:*',
      Resource: [...ses.map((d) => `arn:aws:ses:${region}:${account}:identity/${d}`), ...arns((n) => `arn:aws:ses:${region}:${account}:configuration-set/${n}`)],
    },
    // EC2 is fenced by tag. Reads are free; creating needs the project tag on the request; changing needs it on
    // the resource.
    // Spike hole: the spike also granted ec2:Get*, which includes GetPasswordData, GetConsoleOutput and
    // GetConsoleScreenshot on any instance. CloudFormation's handlers for the EC2 resources shukka supports
    // (instance, launch template, EIP, security group, volume) call no ec2:Get action, so none is granted.
    // Resource "*": Describe* are reads of configuration; most have no resource type. The ones that can return
    // user data are denied below when they are not the project's (DescribeInstanceAttribute) or always (spot
    // requests, which shukka does not use). DescribeLaunchTemplateVersions also returns user data but has no resource
    // type, so it cannot be fenced, and CloudFormation's instance handler needs it: keep secrets out of user data.
    { Sid: 'EC2Read', Effect: 'Allow', Action: 'ec2:Describe*', Resource: '*' },
    // Spike hole: DescribeInstanceAttribute (Attribute=userData) read another project's instance user data.
    // Resource "*": a deny only takes away.
    { Sid: 'EC2DescribeOwnInstancesOnly', Effect: 'Deny', Action: 'ec2:DescribeInstanceAttribute', Resource: '*', Condition: { StringNotEquals: { 'aws:ResourceTag/Project': P } } },
    { Sid: 'EC2NoSpotRequests', Effect: 'Deny', Action: ['ec2:DescribeSpotInstanceRequests', 'ec2:DescribeSpotFleetRequests'], Resource: '*' },
    // Spike hole: the spike allowed these creates on "*" with the request tag, which for RunInstances also matched
    // another project's security groups and any AMI or snapshot. Each create is now limited to the resource type it
    // creates; what an instance uses is granted in the statements after.
    { Sid: 'EC2LaunchTagged', Effect: 'Allow', Action: 'ec2:RunInstances', Resource: ec2('instance'), Condition: { StringEquals: { 'aws:RequestTag/Project': P } } },
    {
      Sid: 'EC2CreateTagged', Effect: 'Allow', Action: ['ec2:CreateSecurityGroup', 'ec2:CreateLaunchTemplate', 'ec2:AllocateAddress', 'ec2:CreateVolume'],
      Resource: [ec2('security-group'), ec2('launch-template'), ec2('elastic-ip'), ec2('volume')],
      Condition: { StringEquals: { 'aws:RequestTag/Project': P } },
    },
    {
      Sid: 'EC2RunInstancesSupporting', Effect: 'Allow', Action: ['ec2:RunInstances', 'ec2:CreateSecurityGroup'],
      Resource: [ec2('subnet'), ec2('vpc'), ec2('volume'), ec2('key-pair')],
    },
    // Spike hole: an instance could launch into another project's network interface. A new interface has no tags
    // yet (IfExists); an existing one must be the project's.
    { Sid: 'EC2RunInstancesInterfaces', Effect: 'Allow', Action: 'ec2:RunInstances', Resource: ec2('network-interface'), Condition: { StringEqualsIfExists: { 'aws:ResourceTag/Project': P } } },
    // Spike hole: image/* was open to any owner's AMI.
    { Sid: 'EC2RunInstancesImages', Effect: 'Allow', Action: 'ec2:RunInstances', Resource: `arn:aws:ec2:${region}::image/*`, Condition: { StringEquals: { 'ec2:Owner': [...amiOwners] } } },
    // Spike hole: security-group/* and launch-template/* for RunInstances were open to every project's; snapshots
    // were open too.
    {
      Sid: 'EC2UseOwnTagged', Effect: 'Allow', Action: ['ec2:RunInstances', 'ec2:CreateVolume'],
      Resource: [ec2('security-group'), ec2('launch-template'), `arn:aws:ec2:${region}::snapshot/*`], Condition: ownTag,
    },
    // Resource "*": tags on a resource being created; fenced by ec2:CreateAction to the creates allowed above.
    { Sid: 'EC2TagOnCreate', Effect: 'Allow', Action: 'ec2:CreateTags', Resource: '*', Condition: { StringEquals: { 'ec2:CreateAction': ec2CreateActions } } },
    // Resource "*": EC2 ids carry no project name; fenced by the Project tag on the resource.
    {
      Sid: 'EC2ChangeOwn', Effect: 'Allow',
      Action: [
        'ec2:CreateTags', 'ec2:DeleteTags', 'ec2:ModifyInstanceAttribute', 'ec2:TerminateInstances', 'ec2:StopInstances', 'ec2:StartInstances',
        'ec2:RebootInstances', 'ec2:AssociateAddress', 'ec2:DisassociateAddress', 'ec2:ReleaseAddress', 'ec2:AuthorizeSecurityGroupIngress',
        'ec2:AuthorizeSecurityGroupEgress', 'ec2:RevokeSecurityGroupIngress', 'ec2:RevokeSecurityGroupEgress',
        'ec2:UpdateSecurityGroupRuleDescriptionsIngress', 'ec2:UpdateSecurityGroupRuleDescriptionsEgress', 'ec2:DeleteSecurityGroup',
        'ec2:CreateLaunchTemplateVersion', 'ec2:ModifyLaunchTemplate', 'ec2:DeleteLaunchTemplate', 'ec2:DeleteLaunchTemplateVersions',
        'ec2:AssociateIamInstanceProfile', 'ec2:ReplaceIamInstanceProfileAssociation', 'ec2:DisassociateIamInstanceProfile', 'ec2:AttachVolume',
        'ec2:DetachVolume', 'ec2:DeleteVolume', 'ec2:ModifyInstanceMetadataOptions',
      ],
      Resource: '*', Condition: ownTag,
    },
    // Spike hole: with the tag on the resource as the only fence, CreateTags could retag another project's resource
    // to this project (or this project's to another). Deny: the Project tag can only ever be set to this project,
    // and never removed. Resource "*": a deny only takes away.
    {
      Sid: 'EC2ProjectTagIsFixed', Effect: 'Deny', Action: ['ec2:CreateTags', 'ec2:DeleteTags'], Resource: '*',
      Condition: { 'ForAnyValue:StringEquals': { 'aws:TagKeys': ['Project'] }, StringNotEquals: { 'aws:RequestTag/Project': P } },
    },
    // Spike hole: elastic IPs and network interfaces were not fenced by tag.
    {
      Sid: 'EC2AssociateToOwnInstance', Effect: 'Allow', Action: ['ec2:AssociateAddress', 'ec2:AssociateIamInstanceProfile', 'ec2:ReplaceIamInstanceProfileAssociation'],
      Resource: [ec2('elastic-ip'), ec2('network-interface')], Condition: ownTag,
    },
    // IAM: own roles and instance profiles; new or changed roles must carry the boundary.
    {
      Sid: 'IAMOwnRoles', Effect: 'Allow',
      Action: [
        'iam:GetRole', 'iam:TagRole', 'iam:UntagRole', 'iam:DeleteRole', 'iam:UpdateRole', 'iam:UpdateRoleDescription', 'iam:UpdateAssumeRolePolicy',
        'iam:DeleteRolePolicy', 'iam:DetachRolePolicy', 'iam:GetRolePolicy', 'iam:ListRolePolicies', 'iam:ListAttachedRolePolicies',
        'iam:ListInstanceProfilesForRole', 'iam:ListRoleTags',
      ],
      Resource: arns((n) => `arn:aws:iam::${account}:role/${n}`),
    },
    {
      Sid: 'IAMBoundedWrites', Effect: 'Allow', Action: ['iam:CreateRole', 'iam:PutRolePolicy', 'iam:AttachRolePolicy', 'iam:PutRolePermissionsBoundary'],
      Resource: arns((n) => `arn:aws:iam::${account}:role/${n}`), Condition: { StringEquals: { 'iam:PermissionsBoundary': boundaryArn } },
    },
    {
      Sid: 'IAMPassOwnRoles', Effect: 'Allow', Action: 'iam:PassRole', Resource: arns((n) => `arn:aws:iam::${account}:role/${n}`),
      Condition: { StringEquals: { 'iam:PassedToService': ['ec2.amazonaws.com', 'lambda.amazonaws.com'] } },
    },
    {
      Sid: 'IAMInstanceProfiles', Effect: 'Allow',
      Action: ['iam:CreateInstanceProfile', 'iam:DeleteInstanceProfile', 'iam:GetInstanceProfile', 'iam:AddRoleToInstanceProfile', 'iam:RemoveRoleFromInstanceProfile', 'iam:TagInstanceProfile', 'iam:UntagInstanceProfile'],
      Resource: arns((n) => `arn:aws:iam::${account}:instance-profile/${n}`),
    },
    { Sid: 'IAMReadOIDC', Effect: 'Allow', Action: ['iam:GetOpenIDConnectProvider'], Resource: `arn:aws:iam::${account}:oidc-provider/token.actions.githubusercontent.com` },
    // Spike hole: the spike protected only the first execution policy (now there are three).
    {
      Sid: 'NoEscapeFromBoundary', Effect: 'Deny',
      Action: ['iam:DeleteRolePermissionsBoundary', 'iam:CreatePolicyVersion', 'iam:DeletePolicy', 'iam:DeletePolicyVersion', 'iam:SetDefaultPolicyVersion'],
      Resource: [boundaryArn, ...execArns, ...arns((n) => `arn:aws:iam::${account}:role/${n}`)],
    },
  ];

  // What roles the project creates (servers, Lambdas, its CI roles) may ever do: use the project's own data and services.
  const dataStatements = resourceStatements.filter((st) => DATA_SIDS.has(st.Sid));

  const all: PolicyStatementJson[] = [
    ...resourceStatements,
    { Sid: 'BootstrapVersion', Effect: 'Allow', Action: ['ssm:GetParameter', 'ssm:GetParameters'], Resource: `arn:aws:ssm:${region}:${account}:parameter/cdk-bootstrap/${qualifier}/version` },
  ];

  // The boundary grants no IAM or EC2 management, so a bounded role cannot make a role without the boundary or
  // reach another project.
  const boundary: PolicyStatementJson[] = [
    ...dataStatements,
    // Spike hole: RuntimeAgents had every agent call on "*", including instance- and document-scoped SSM calls and
    // logs writes to any log group. Logs now come only from the Logs statement (the project's log groups);
    // instance-scoped calls need the project's tag on the instance; document-scoped calls name the documents.
    // Resource "*": what is left has no resource type (Systems Manager's service authorization reference lists
    // none for DescribeInstanceProperties, GetDeployablePatchSnapshotForInstance, ListAssociations, PutInventory,
    // GetCommandInvocation, and none at all for GetManifest and PutConfigurePackageResult).
    {
      Sid: 'RuntimeAgents', Effect: 'Allow',
      Action: [
        'ssm:DescribeInstanceProperties', 'ssm:GetDeployablePatchSnapshotForInstance', 'ssm:GetManifest', 'ssm:ListAssociations', 'ssm:PutInventory',
        'ssm:PutConfigurePackageResult', 'ssm:GetCommandInvocation', 'ssmmessages:*', 'ec2messages:*', 'cloudwatch:PutMetricData',
        'sts:GetCallerIdentity', 'ec2:DescribeInstances', 'ec2:DescribeTags',
      ],
      Resource: '*',
    },
    {
      Sid: 'AgentOnOwnInstance', Effect: 'Allow',
      Action: ['ssm:UpdateInstanceInformation', 'ssm:ListInstanceAssociations', 'ssm:PutComplianceItems', 'ssm:UpdateInstanceAssociationStatus', 'ssm:UpdateAssociationStatus'],
      Resource: ec2('instance'), Condition: ownTag,
    },
    {
      Sid: 'AgentDocuments', Effect: 'Allow', Action: ['ssm:GetDocument', 'ssm:DescribeDocumentParameters', 'ssm:UpdateAssociationStatus'],
      Resource: [`arn:aws:ssm:${region}::document/*`, ...arns((n) => `arn:aws:ssm:${region}:${account}:document/${n}`)],
    },
    // Association ids carry no project name; this is the account's associations in the region.
    { Sid: 'AgentAssociations', Effect: 'Allow', Action: 'ssm:DescribeAssociation', Resource: `arn:aws:ssm:${region}:${account}:association/*` },
    // Resource "*": the key behind SecureString parameters (often the AWS-managed aws/ssm key); fenced by
    // kms:ViaService to decryption through SSM, whose parameters are themselves fenced above.
    { Sid: 'DecryptViaSSM', Effect: 'Allow', Action: 'kms:Decrypt', Resource: '*', Condition: { StringEquals: { 'kms:ViaService': `ssm.${region}.amazonaws.com` } } },
    // Resource "*": SES authorises against the identity used, which may be an address or a domain; fenced by the
    // From address on the project's domains.
    {
      Sid: 'SendMail', Effect: 'Allow', Action: ['ses:SendEmail', 'ses:SendRawEmail'], Resource: '*',
      Condition: { StringLike: { 'ses:FromAddress': ses.map((d) => `*@${d}`) } },
    },
    // Spike hole: every bounded role (servers, Lambdas) could assume the bootstrap roles, including the lookup role.
    // Only the pipeline's infra role may, and only the deploy and file-publishing roles.
    {
      Sid: 'DeployThroughBootstrap', Effect: 'Allow', Action: 'sts:AssumeRole',
      Resource: [`arn:aws:iam::${account}:role/cdk-${qualifier}-deploy-role-*`, `arn:aws:iam::${account}:role/cdk-${qualifier}-file-publishing-role-*`],
      Condition: { ArnEquals: { 'aws:PrincipalArn': `arn:aws:iam::${account}:role/${infraRoleName(P)}` } },
    },
    // Spike hole (finding 4): ssm:SendCommand is authorised against both the document and each target instance. The
    // spike allowed it on "*" with StringEqualsIfExists on the instance tag, which let through an instance with no
    // Project tag. Split: the document by ARN, instances only with the project's tag.
    { Sid: 'RunOnOwnServersDocument', Effect: 'Allow', Action: 'ssm:SendCommand', Resource: `arn:aws:ssm:${region}::document/AWS-RunShellScript` },
    { Sid: 'RunOnOwnServers', Effect: 'Allow', Action: 'ssm:SendCommand', Resource: ec2('instance'), Condition: ownTag },
  ];

  return {
    executionA: { Version: '2012-10-17', Statement: all.filter((st) => !INFRA_SIDS.has(st.Sid) && !IAM_SIDS.has(st.Sid)) },
    executionB: { Version: '2012-10-17', Statement: all.filter((st) => INFRA_SIDS.has(st.Sid)) },
    executionC: { Version: '2012-10-17', Statement: all.filter((st) => IAM_SIDS.has(st.Sid)) },
    boundary: { Version: '2012-10-17', Statement: boundary },
  };
}

export interface ShukkaBoundaryProps {
  /** The project name from shukka.json: `^[a-z][a-z0-9-]{1,20}$`. */
  readonly project: string;
  /** The project's CDK bootstrap qualifier, `^[a-z0-9]{1,10}$`. Default: the project name. */
  readonly qualifier?: string;
  /** The Route 53 hosted zone the project may change, by id. */
  readonly hostedZoneId: string;
  /** SES identities (domains) the project owns and may send mail from. No wildcards. */
  readonly sesDomains: readonly string[];
  /** Owners whose AMIs the project's instances may launch from (`ec2:Owner`). Default `['amazon']`. */
  readonly amiOwners?: readonly string[];
}

/**
 * The project's permissions boundary and the three managed policies of its CloudFormation execution role, in the
 * stack's account and region. `shukka bootstrap` deploys this, then runs `cdk bootstrap` with the execution
 * policies. Throws on an invalid project name, qualifier, mail domain or AMI owner.
 */
export class ShukkaBoundary extends Construct {
  readonly boundaryPolicy: iam.ManagedPolicy;
  /** The execution policies, in the order `cdk bootstrap --cloudformation-execution-policies` takes them. */
  readonly executionPolicies: [iam.ManagedPolicy, iam.ManagedPolicy, iam.ManagedPolicy];

  constructor(scope: Construct, id: string, props: ShukkaBoundaryProps) {
    super(scope, id);
    const stack = Stack.of(this);
    const docs = fenceDocuments({
      project: props.project,
      account: stack.account,
      region: stack.region,
      qualifier: props.qualifier ?? props.project,
      hostedZoneId: props.hostedZoneId,
      sesDomains: props.sesDomains,
      amiOwners: props.amiOwners,
    });
    const [execA, execB, execC] = executionPolicyNames(props.project);
    const policy = (cid: string, name: string, doc: PolicyDocumentJson) =>
      new iam.ManagedPolicy(this, cid, { managedPolicyName: name, document: iam.PolicyDocument.fromJson(doc) });
    this.boundaryPolicy = policy('Boundary', boundaryPolicyName(props.project), docs.boundary);
    this.executionPolicies = [
      policy('ExecutionA', execA, docs.executionA),
      policy('ExecutionB', execB, docs.executionB),
      policy('ExecutionC', execC, docs.executionC),
    ];
  }
}

/**
 * Set the project's permissions boundary on every IAM role in `scope` (an app or a stack), including roles CDK
 * creates for custom resources. The execution policy refuses to create a role without it.
 */
export function applyBoundary(scope: IConstruct, project: string): void {
  const name = boundaryPolicyName(project);
  Aspects.of(scope).add({
    visit(node: IConstruct) {
      if (CfnResource.isCfnResource(node) && node.cfnResourceType === iam.CfnRole.CFN_RESOURCE_TYPE_NAME) {
        // Pseudo parameters resolve in each role's own stack.
        node.addPropertyOverride('PermissionsBoundary', `arn:${Aws.PARTITION}:iam::${Aws.ACCOUNT_ID}:policy/${name}`);
      }
    },
  });
}
