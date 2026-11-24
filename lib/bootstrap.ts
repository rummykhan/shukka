// The project's own CDK bootstrap (security review of shu-i1b, access-2). The stock `cdk bootstrap` template lets its
// deploy role change any stack in the account, and CloudFormation reuses the role stored on a stack without
// iam:PassRole, so a project's pipeline could update another project's stack (or Shukka-Account, or a boundary
// stack) and run as that stack's admin execution role. This template keeps the stock resource names, outputs and
// version parameter, so shukkaSynthesizer(qualifier) and the CDK CLI work unchanged, but:
//
// - the deploy role may use CloudFormation only on the project's stacks (`<project>-*`, `<Project>-*`) and only
//   with the project's own execution role (cloudformation:RoleArn; denied when absent or different);
// - the file-publishing role may write only the project's asset bucket;
// - the execution role carries the project's three execution policies (ShukkaBoundary) and nothing else;
// - there is no lookup role: the stock one has ReadOnlyAccess over the whole shared account, the project's infra role
//   may not assume it (ShukkaAccess, and the boundary's DeployThroughBootstrap), and cdk.context.json is committed,
//   so a deploy needs no live lookup. A missing lookup role costs nothing a project deploy uses;
// - there is no container-asset repository or image-publishing role: the infra role may not assume that role either,
//   so a project that needs Docker image assets must be designed for first.
//
// Deploy it with CloudFormation as the stack named by bootstrapStackName(qualifier). It takes no parameters; the
// stock template's parameters (trusted accounts, execution policies, KMS key) are fixed here on purpose.
import { executionPolicyNames, infraRoleName, validateProjectName } from './boundary.js';

/**
 * The bootstrap version this template writes to `/cdk-bootstrap/<qualifier>/version`: that of the stock template its
 * resource shapes follow (aws-cdk 2, bootstrap template version 28). The CDK CLI refuses a deploy when this is lower
 * than the version a synthesized stack requires (6 for DefaultStackSynthesizer, 22 with session tags).
 */
export const SHUKKA_BOOTSTRAP_VERSION = 28;

// An IAM role or user ARN, literal or with `*` in the name; never a bare wildcard or another account form.
const PRINCIPAL_RE = /^arn:aws[a-z-]*:iam::[0-9]{12}:(?:role|user)\/[A-Za-z0-9+=,.@_/-][A-Za-z0-9+=,.@_/*-]*$/;
const QUALIFIER_RE = /^[a-z0-9]{1,10}$/;

export interface BootstrapTemplateInputs {
  /** The project name from shukka.json: `^[a-z][a-z0-9-]{1,20}$`. */
  readonly project: string;
  /** The project's CDK bootstrap qualifier, `^[a-z0-9]{1,10}$`. Default: the project name. */
  readonly qualifier?: string;
  /**
   * Who else may assume the deploy and file-publishing roles besides the project's infra role: ARN patterns of admin
   * roles or users for `shukka deploy` from a laptop (`aws:PrincipalArn`, ArnLike). Default: none.
   */
  readonly emergencyPrincipals?: readonly string[];
}

/**
 * Name of the CloudFormation stack that holds the project's bootstrap. It does not start with the project name, so
 * the project's own deploy role cannot change it.
 */
export function bootstrapStackName(qualifier: string): string {
  return `CDKToolkit-${qualifier}`;
}

/**
 * Name of the stack that holds the project's ShukkaBoundary (deployed by `shukka bootstrap` before this template).
 * Like the bootstrap stack, it must not start with the project name: the project's deploy role could change it.
 */
export function boundaryStackName(project: string): string {
  return `Shukka-Boundary-${project}`;
}

/** Names of the resources the template creates, as CDK's DefaultStackSynthesizer expects them (pseudo parameters in `${}`). */
export function bootstrapNames(qualifier: string) {
  const suffix = '${AWS::AccountId}-${AWS::Region}';
  return {
    deployRole: `cdk-${qualifier}-deploy-role-${suffix}`,
    filePublishingRole: `cdk-${qualifier}-file-publishing-role-${suffix}`,
    executionRole: `cdk-${qualifier}-cfn-exec-role-${suffix}`,
    assetBucket: `cdk-${qualifier}-assets-${suffix}`,
    versionParameter: `/cdk-bootstrap/${qualifier}/version`,
  };
}

/** The CloudFormation actions that take a RoleArn (and so the cloudformation:RoleArn condition key). */
export const ROLE_ARN_ACTIONS = [
  'cloudformation:CreateChangeSet',
  'cloudformation:CreateStack',
  'cloudformation:UpdateStack',
  'cloudformation:DeleteStack',
  'cloudformation:RollbackStack',
  'cloudformation:ContinueUpdateRollback',
] as const;

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
export type CloudFormationTemplate = { [k: string]: Json };

const sub = (s: string): Json => ({ 'Fn::Sub': s });

/**
 * The project's bootstrap template as a CloudFormation template object (write it out with JSON.stringify). Throws on
 * an invalid project name or qualifier.
 */
export function bootstrapTemplate(inputs: BootstrapTemplateInputs): CloudFormationTemplate {
  const project = inputs.project;
  const qualifier = inputs.qualifier ?? project;
  validateProjectName(project);
  if (!QUALIFIER_RE.test(qualifier)) throw new Error(`shukka: qualifier ${JSON.stringify(qualifier)} must match ${QUALIFIER_RE}`);
  const emergency = inputs.emergencyPrincipals ?? [];
  for (const p of emergency) {
    if (!PRINCIPAL_RE.test(p)) throw new Error(`shukka: emergency principal ${JSON.stringify(p)} must be an IAM role or user ARN (pattern)`);
  }

  const Project = project.charAt(0).toUpperCase() + project.slice(1);
  const n = bootstrapNames(qualifier);
  const iamArn = (path: string) => `arn:\${AWS::Partition}:iam::\${AWS::AccountId}:${path}`;
  const execRoleArn = iamArn(`role/${n.executionRole}`);
  const bucketArn = `arn:\${AWS::Partition}:s3:::${n.assetBucket}`;
  // The project's stacks by name. The hyphen does not keep out every other project (`trendigle-x` is inside
  // `trendigle-*`): the CLI refuses a project name that prefixes another in the account, and validateProjectName
  // refuses names that would reach shukka's own stacks.
  const ownStacks = [project, Project].map((p) => sub(`arn:\${AWS::Partition}:cloudformation:\${AWS::Region}:\${AWS::AccountId}:stack/${p}-*/*`));
  // Only the project's infra role, and the emergency principals named at bootstrap (`shukka deploy` from a laptop).
  const accountTrust: Json = {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow', Action: ['sts:AssumeRole', 'sts:TagSession'], Principal: { AWS: { Ref: 'AWS::AccountId' } },
        Condition: { ArnLike: { 'aws:PrincipalArn': [sub(iamArn(`role/${infraRoleName(project)}`)), ...emergency] } },
      },
    ],
  };
  // The file-publishing role also trusts the project's own deploy role: `shukka deploy` hands cdk only a deploy-role
  // session (no admin credentials in project code), and cdk then assumes this role to publish file assets.
  const publishingTrust: Json = {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow', Action: ['sts:AssumeRole', 'sts:TagSession'], Principal: { AWS: { Ref: 'AWS::AccountId' } },
        Condition: { ArnLike: { 'aws:PrincipalArn': [sub(iamArn(`role/${infraRoleName(project)}`)), sub(iamArn(`role/${n.deployRole}`)), ...emergency] } },
      },
    ],
  };

  return {
    AWSTemplateFormatVersion: '2010-09-09',
    Description: `shukka bootstrap for project ${project} (qualifier ${qualifier}): deploys only the project's stacks, only with its own execution role`,
    Resources: {
      StagingBucket: {
        Type: 'AWS::S3::Bucket',
        UpdateReplacePolicy: 'Retain',
        DeletionPolicy: 'Retain',
        Properties: {
          BucketName: sub(n.assetBucket),
          BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] },
          PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
          OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
          VersioningConfiguration: { Status: 'Enabled' },
          LifecycleConfiguration: {
            Rules: [
              { Id: 'CleanupOldVersions', Status: 'Enabled', NoncurrentVersionExpiration: { NoncurrentDays: 30 } },
              { Id: 'AbortIncompleteMultipartUploads', Status: 'Enabled', AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } },
            ],
          },
        },
      },
      StagingBucketPolicy: {
        Type: 'AWS::S3::BucketPolicy',
        Properties: {
          Bucket: { Ref: 'StagingBucket' },
          PolicyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Sid: 'AllowSSLRequestsOnly', Effect: 'Deny', Principal: '*', Action: 's3:*',
                Resource: [sub(bucketArn), sub(`${bucketArn}/*`)],
                Condition: { Bool: { 'aws:SecureTransport': 'false' } },
              },
            ],
          },
        },
      },
      FilePublishingRole: {
        Type: 'AWS::IAM::Role',
        Properties: {
          RoleName: sub(n.filePublishingRole),
          AssumeRolePolicyDocument: publishingTrust,
          Policies: [
            {
              PolicyName: 'publish-assets',
              PolicyDocument: {
                Version: '2012-10-17',
                Statement: [
                  {
                    // What cdk-assets calls to upload a file asset: bucket location and encryption, a listing to skip
                    // assets already there, and the upload. No deletes.
                    Sid: 'OwnAssetBucketOnly', Effect: 'Allow',
                    Action: ['s3:GetObject*', 's3:GetBucketLocation', 's3:GetEncryptionConfiguration', 's3:ListBucket', 's3:PutObject', 's3:AbortMultipartUpload'],
                    Resource: [sub(bucketArn), sub(`${bucketArn}/*`)],
                    Condition: { StringEquals: { 'aws:ResourceAccount': { Ref: 'AWS::AccountId' } } },
                  },
                ],
              },
            },
          ],
          Tags: [{ Key: 'aws-cdk:bootstrap-role', Value: 'file-publishing' }],
        },
      },
      DeploymentActionRole: {
        Type: 'AWS::IAM::Role',
        Properties: {
          RoleName: sub(n.deployRole),
          AssumeRolePolicyDocument: accountTrust,
          Policies: [
            {
              PolicyName: 'deploy-own-stacks',
              PolicyDocument: {
                Version: '2012-10-17',
                Statement: [
                  {
                    // What `cdk deploy` and `cdk destroy` do to a stack, and what `cdk diff` and the pipeline read
                    // (DescribeStacks carries the shukka:revision tag). Change sets are authorised on their stack.
                    Sid: 'OwnStacksOnly', Effect: 'Allow',
                    Action: [
                      ...ROLE_ARN_ACTIONS,
                      'cloudformation:DescribeChangeSet', 'cloudformation:ExecuteChangeSet', 'cloudformation:DeleteChangeSet',
                      'cloudformation:DescribeStacks', 'cloudformation:DescribeStackEvents', 'cloudformation:DescribeStackResources',
                      'cloudformation:ListStackResources', 'cloudformation:GetTemplate', 'cloudformation:GetTemplateSummary',
                      'cloudformation:UpdateTerminationProtection',
                    ],
                    Resource: ownStacks,
                  },
                  {
                    // Resource "*": a deny that only takes away. CloudFormation would otherwise run with the role
                    // stored on the stack, which for a stack made outside shukka can be an admin role.
                    Sid: 'NoDeployWithoutRoleArn', Effect: 'Deny', Action: [...ROLE_ARN_ACTIONS], Resource: '*',
                    Condition: { Null: { 'cloudformation:RoleArn': 'true' } },
                  },
                  {
                    // Resource "*": a deny that only takes away. Only the project's own execution role.
                    Sid: 'OnlyOwnExecutionRole', Effect: 'Deny', Action: [...ROLE_ARN_ACTIONS], Resource: '*',
                    Condition: { ArnNotEquals: { 'cloudformation:RoleArn': sub(execRoleArn) } },
                  },
                  {
                    Sid: 'PassOwnExecutionRole', Effect: 'Allow', Action: 'iam:PassRole', Resource: sub(execRoleArn),
                    Condition: { StringEquals: { 'iam:PassedToService': 'cloudformation.amazonaws.com' } },
                  },
                  {
                    // CloudFormation reads the template from the asset bucket with the caller's credentials.
                    Sid: 'ReadOwnAssetBucket', Effect: 'Allow', Action: ['s3:GetObject*', 's3:GetBucketLocation', 's3:ListBucket'],
                    Resource: [sub(bucketArn), sub(`${bucketArn}/*`)],
                  },
                  {
                    Sid: 'ReadVersion', Effect: 'Allow', Action: ['ssm:GetParameter', 'ssm:GetParameters'],
                    Resource: sub(`arn:\${AWS::Partition}:ssm:\${AWS::Region}:\${AWS::AccountId}:parameter${n.versionParameter}`),
                  },
                  {
                    // Same-account trust naming the account needs this allow too: only the project's own
                    // file-publishing role, so a laptop deploy (deploy-role session) can publish file assets.
                    Sid: 'AssumeOwnFilePublishingRole', Effect: 'Allow', Action: ['sts:AssumeRole', 'sts:TagSession'],
                    Resource: sub(iamArn(`role/${n.filePublishingRole}`)),
                  },
                  // Resource "*": sts:GetCallerIdentity has no resource type.
                  { Sid: 'WhoAmI', Effect: 'Allow', Action: 'sts:GetCallerIdentity', Resource: '*' },
                ],
              },
            },
          ],
          Tags: [{ Key: 'aws-cdk:bootstrap-role', Value: 'deploy' }],
        },
      },
      CloudFormationExecutionRole: {
        Type: 'AWS::IAM::Role',
        Properties: {
          RoleName: sub(n.executionRole),
          AssumeRolePolicyDocument: {
            Version: '2012-10-17',
            Statement: [{ Effect: 'Allow', Action: 'sts:AssumeRole', Principal: { Service: 'cloudformation.amazonaws.com' } }],
          },
          // The fence (ShukkaBoundary), deployed before this template; nothing else.
          ManagedPolicyArns: executionPolicyNames(project).map((p) => sub(iamArn(`policy/${p}`))),
        },
      },
      CdkBootstrapVersion: {
        Type: 'AWS::SSM::Parameter',
        Properties: { Type: 'String', Name: n.versionParameter, Value: String(SHUKKA_BOOTSTRAP_VERSION) },
      },
    },
    Outputs: {
      BucketName: { Description: 'The name of the S3 bucket owned by the CDK toolkit stack', Value: sub('${StagingBucket}') },
      BucketDomainName: { Description: 'The domain name of the S3 bucket owned by the CDK toolkit stack', Value: sub('${StagingBucket.RegionalDomainName}') },
      BootstrapVersion: {
        Description: 'The version of the bootstrap resources that are currently mastered in this stack',
        Value: { 'Fn::GetAtt': ['CdkBootstrapVersion', 'Value'] },
      },
    },
  };
}
