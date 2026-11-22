// The per-project fence (design D5, spike S2): a permissions boundary for every role the project's stacks create,
// and the execution policy of the project's CloudFormation execution role, split in two managed policies because
// a managed policy holds at most 6,144 characters. A port of docs/factory/v1/spikes/s2/policy.py; the statements
// are the spike's, except that ssm:SendCommand in the boundary is split (spike S2, finding 4).
//
// The fence is a name prefix: resources must be named `<project>*` or `<Project>*`. Project names in one account
// must therefore not be prefixes of one another.
//
// Statements with Resource "*" are of two kinds, and each says which in a comment:
// - actions with no resource type (nothing narrower than "*" can be written);
// - actions whose resource does not exist yet or has no project name, fenced instead by a condition on a tag, the
//   calling service or the From address.
import { Aspects, Aws, CfnResource, Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct, type IConstruct } from 'constructs';

export interface FenceInputs {
  /** The project name from shukka.json; lower case, and not a prefix of another project in the account. */
  readonly project: string;
  readonly account: string;
  readonly region: string;
  /** The project's CDK bootstrap qualifier. */
  readonly qualifier: string;
  /** The Route 53 hosted zone the project may change, by id. */
  readonly hostedZoneId: string;
  /** SES identities (domains) the project owns and may send mail from. */
  readonly sesDomains: readonly string[];
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
  /** Execution policy, part two: EC2 and IAM. */
  readonly executionB: PolicyDocumentJson;
  /** The permissions boundary on every role the project's stacks create. */
  readonly boundary: PolicyDocumentJson;
}

/** Name of the boundary managed policy; roles created by the project must carry it. */
export function boundaryPolicyName(project: string): string {
  return `${project}-shukka-boundary`;
}

/** Names of the two execution managed policies, in the order `cdk bootstrap` takes them. */
export function executionPolicyNames(project: string): [string, string] {
  return [`${project}-shukka-execution`, `${project}-shukka-execution-infra`];
}

const INFRA_SIDS = new Set([
  'EC2Read', 'EC2CreateTagged', 'EC2RunInstancesSupporting', 'EC2TagOnCreate', 'EC2ChangeOwn',
  'EC2AssociateToOwnInstance', 'IAMOwnRoles', 'IAMBoundedWrites', 'IAMPassOwnRoles', 'IAMInstanceProfiles',
  'IAMReadOIDC', 'NoEscapeFromBoundary',
]);

const DATA_SIDS = new Set(['DynamoDB', 'S3', 'Lambda', 'SQS', 'SNS', 'Alarms', 'Logs', 'Parameters']);

/** The fence documents for one project, as plain IAM JSON. */
export function fenceDocuments(inputs: FenceInputs): FenceDocuments {
  const { project: P, account, region, qualifier, hostedZoneId: zone, sesDomains: ses } = inputs;
  // CDK's generated names start with the stack name, which is capitalised.
  const Pc = P.slice(0, 1).toUpperCase() + P.slice(1);
  const names = [`${P}*`, `${Pc}*`];
  const arns = (fmt: (n: string) => string) => names.map(fmt);
  const boundaryArn = `arn:aws:iam::${account}:policy/${boundaryPolicyName(P)}`;
  const execArn = `arn:aws:iam::${account}:policy/${executionPolicyNames(P)[0]}`;

  const tbl = arns((n) => `arn:aws:dynamodb:${region}:${account}:table/${n}`);
  const ec2CreateActions = ['RunInstances', 'CreateSecurityGroup', 'CreateLaunchTemplate', 'AllocateAddress', 'CreateVolume'];

  // Everything a project's own resources may have done to them (shared by the execution policy and the boundary).
  const resourceStatements: PolicyStatementJson[] = [
    { Sid: 'DynamoDB', Effect: 'Allow', Action: 'dynamodb:*', Resource: [...tbl, ...tbl.map((t) => `${t}/*`)] },
    { Sid: 'S3', Effect: 'Allow', Action: 's3:*', Resource: [...arns((n) => `arn:aws:s3:::${n}`), ...arns((n) => `arn:aws:s3:::${n}/*`)] },
    {
      Sid: 'Lambda', Effect: 'Allow', Action: 'lambda:*',
      Resource: [...arns((n) => `arn:aws:lambda:${region}:${account}:function:${n}`), ...arns((n) => `arn:aws:lambda:${region}:${account}:function:${n}:*`)],
    },
    // Resource "*": CreateEventSourceMapping and ListEventSourceMappings have no resource type; the mapping ARN
    // (a UUID) of Get/Update/DeleteEventSourceMapping carries no project name.
    {
      Sid: 'LambdaEventSources', Effect: 'Allow',
      Action: ['lambda:CreateEventSourceMapping', 'lambda:UpdateEventSourceMapping', 'lambda:DeleteEventSourceMapping', 'lambda:GetEventSourceMapping', 'lambda:ListEventSourceMappings'],
      Resource: '*',
    },
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
    // Resource "*": Describe* have no resource type; the readable Get* are reads of the account's own EC2 state.
    { Sid: 'EC2Read', Effect: 'Allow', Action: ['ec2:Describe*', 'ec2:Get*'], Resource: '*' },
    // Resource "*": the resource does not exist yet; fenced by the Project tag on the request.
    {
      Sid: 'EC2CreateTagged', Effect: 'Allow', Action: ['ec2:RunInstances', 'ec2:CreateSecurityGroup', 'ec2:CreateLaunchTemplate', 'ec2:AllocateAddress', 'ec2:CreateVolume'],
      Resource: '*', Condition: { StringEquals: { 'aws:RequestTag/Project': P } },
    },
    {
      Sid: 'EC2RunInstancesSupporting', Effect: 'Allow', Action: ['ec2:RunInstances', 'ec2:CreateSecurityGroup'],
      Resource: [
        `arn:aws:ec2:${region}::image/*`, `arn:aws:ec2:${region}:${account}:subnet/*`, `arn:aws:ec2:${region}:${account}:vpc/*`,
        `arn:aws:ec2:${region}:${account}:network-interface/*`, `arn:aws:ec2:${region}:${account}:volume/*`,
        `arn:aws:ec2:${region}:${account}:security-group/*`, `arn:aws:ec2:${region}:${account}:launch-template/*`,
        `arn:aws:ec2:${region}:${account}:key-pair/*`,
      ],
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
      Resource: '*', Condition: { StringEquals: { 'aws:ResourceTag/Project': P } },
    },
    {
      Sid: 'EC2AssociateToOwnInstance', Effect: 'Allow', Action: ['ec2:AssociateAddress', 'ec2:AssociateIamInstanceProfile', 'ec2:ReplaceIamInstanceProfileAssociation'],
      Resource: [`arn:aws:ec2:${region}:${account}:elastic-ip/*`, `arn:aws:ec2:${region}:${account}:network-interface/*`],
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
    {
      Sid: 'NoEscapeFromBoundary', Effect: 'Deny',
      Action: ['iam:DeleteRolePermissionsBoundary', 'iam:CreatePolicyVersion', 'iam:DeletePolicy', 'iam:DeletePolicyVersion', 'iam:SetDefaultPolicyVersion'],
      Resource: [boundaryArn, execArn, ...arns((n) => `arn:aws:iam::${account}:role/${n}`)],
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
    // Resource "*": the SSM agent, Session Manager and CloudWatch agent calls a server makes about itself. Most have
    // no resource type (ssmmessages, ec2messages, PutMetricData, GetCallerIdentity, DescribeInstances, DescribeTags,
    // GetCommandInvocation); the rest act on the calling instance or AWS-owned documents and associations.
    {
      Sid: 'RuntimeAgents', Effect: 'Allow',
      Action: [
        'ssm:UpdateInstanceInformation', 'ssm:ListInstanceAssociations', 'ssm:DescribeInstanceProperties', 'ssm:DescribeDocumentParameters',
        'ssm:GetDocument', 'ssm:DescribeAssociation', 'ssm:GetDeployablePatchSnapshotForInstance', 'ssm:GetManifest', 'ssm:ListAssociations',
        'ssm:PutInventory', 'ssm:PutComplianceItems', 'ssm:PutConfigurePackageResult', 'ssm:UpdateAssociationStatus',
        'ssm:UpdateInstanceAssociationStatus', 'ssmmessages:*', 'ec2messages:*', 'cloudwatch:PutMetricData', 'logs:CreateLogGroup',
        'logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams', 'sts:GetCallerIdentity', 'ec2:DescribeInstances',
        'ec2:DescribeTags', 'ssm:GetCommandInvocation',
      ],
      Resource: '*',
    },
    // Resource "*": the key behind SecureString parameters (often the AWS-managed aws/ssm key); fenced by
    // kms:ViaService to decryption through SSM, whose parameters are themselves fenced above.
    { Sid: 'DecryptViaSSM', Effect: 'Allow', Action: 'kms:Decrypt', Resource: '*', Condition: { StringEquals: { 'kms:ViaService': `ssm.${region}.amazonaws.com` } } },
    // Resource "*": SES authorises against the identity used, which may be an address or a domain; fenced by the
    // From address on the project's domains.
    {
      Sid: 'SendMail', Effect: 'Allow', Action: ['ses:SendEmail', 'ses:SendRawEmail'], Resource: '*',
      Condition: { StringLike: { 'ses:FromAddress': ses.map((d) => `*@${d}`) } },
    },
    { Sid: 'DeployThroughBootstrap', Effect: 'Allow', Action: 'sts:AssumeRole', Resource: `arn:aws:iam::${account}:role/cdk-${qualifier}-*` },
    // ssm:SendCommand is authorised against both the document and each target instance. The spike allowed it on
    // "*" with StringEqualsIfExists on the instance tag, which let through an instance with no Project tag
    // (finding 4). Split: the document by ARN, instances only with the project's tag.
    { Sid: 'RunOnOwnServersDocument', Effect: 'Allow', Action: 'ssm:SendCommand', Resource: `arn:aws:ssm:${region}::document/AWS-RunShellScript` },
    {
      Sid: 'RunOnOwnServers', Effect: 'Allow', Action: 'ssm:SendCommand', Resource: `arn:aws:ec2:${region}:${account}:instance/*`,
      Condition: { StringEquals: { 'aws:ResourceTag/Project': P } },
    },
  ];

  return {
    executionA: { Version: '2012-10-17', Statement: all.filter((st) => !INFRA_SIDS.has(st.Sid)) },
    executionB: { Version: '2012-10-17', Statement: all.filter((st) => INFRA_SIDS.has(st.Sid)) },
    boundary: { Version: '2012-10-17', Statement: boundary },
  };
}

export interface ShukkaBoundaryProps {
  /** The project name from shukka.json. */
  readonly project: string;
  /** The project's CDK bootstrap qualifier. Default: the project name. */
  readonly qualifier?: string;
  /** The Route 53 hosted zone the project may change, by id. */
  readonly hostedZoneId: string;
  /** SES identities (domains) the project owns and may send mail from. */
  readonly sesDomains: readonly string[];
}

/**
 * The project's permissions boundary and the two managed policies of its CloudFormation execution role, in the
 * stack's account and region. `shukka bootstrap` deploys this, then runs `cdk bootstrap` with the execution
 * policies.
 */
export class ShukkaBoundary extends Construct {
  readonly boundaryPolicy: iam.ManagedPolicy;
  /** The execution policies, in the order `cdk bootstrap --cloudformation-execution-policies` takes them. */
  readonly executionPolicies: [iam.ManagedPolicy, iam.ManagedPolicy];

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
    });
    const [execA, execB] = executionPolicyNames(props.project);
    const policy = (cid: string, name: string, doc: PolicyDocumentJson) =>
      new iam.ManagedPolicy(this, cid, { managedPolicyName: name, document: iam.PolicyDocument.fromJson(doc) });
    this.boundaryPolicy = policy('Boundary', boundaryPolicyName(props.project), docs.boundary);
    this.executionPolicies = [policy('ExecutionA', execA, docs.executionA), policy('ExecutionB', execB, docs.executionB)];
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
