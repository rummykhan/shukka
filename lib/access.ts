import { ArnFormat, Stack, Token } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface ShukkaAccessProps {
  /** Project name, as in shukka.json: `^[a-z][a-z0-9-]{1,20}$`. Roles are named `<project>-shukka-infra|app|diff`. */
  readonly project: string;
  /** Subject repo segment: `owner/repo` or the immutable `owner@id/repo@id`. */
  readonly githubRepo: string;
  /** Tag pattern the shukka workflow ref must match. Default `v1*`. */
  readonly shukkaVersions?: string;
  /** ARN of the account's GitHub OIDC provider (output of the Shukka-Account stack). Default: that provider's ARN in this account. Never created here. */
  readonly oidcProviderArn?: string;
  readonly deployBucket: s3.IBucket;
  /** Tag that marks the project's servers. Default `{ key: 'Project', value: project }`. */
  readonly instanceTag?: { key: string; value: string };
  /** Parameter Store path the app role may read below. Default `/<project>/prod`. */
  readonly ssmPath?: string;
  /** CDK bootstrap qualifier, as in shukka.json. Default: the project name, when it is a valid qualifier. */
  readonly qualifier?: string;
  /**
   * Release-candidate testing only: also trust shukka's workflows at this branch (`refs/heads/<allowBranch>`).
   * Off by default; never set it in a production project.
   */
  readonly allowBranch?: string;
}

const PROVIDER_HOST = 'token.actions.githubusercontent.com';
const SHUKKA_WORKFLOWS = 'rummykhan/shukka/.github/workflows';

const PROJECT_RE = /^[a-z][a-z0-9-]{1,20}$/;
const QUALIFIER_RE = /^[a-z0-9]{1,10}$/;
// GitHub owner: alphanumerics and single hyphens, not starting with a hyphen. Repo: alphanumerics, '.', '_', '-'.
const OWNER = '[A-Za-z0-9][A-Za-z0-9-]{0,38}';
const REPO = '[A-Za-z0-9._-]{1,100}';
const GITHUB_REPO_RE = new RegExp(`^(?:${OWNER}/${REPO}|${OWNER}@[0-9]+/${REPO}@[0-9]+)$`);
// A tag pattern: starts with a literal character; '*' allowed after that, '?' never.
const VERSIONS_RE = /^[A-Za-z0-9][A-Za-z0-9._*-]*$/;
// A branch name, literal (no wildcards).
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SSM_PATH_RE = /^(?:\/[A-Za-z0-9._-]+)+$/;
const PROVIDER_ARN_RE = /^arn:aws[a-z-]*:iam::[0-9]{12}:oidc-provider\/token\.actions\.githubusercontent\.com$/;

function check(ok: boolean, message: string): void {
  if (!ok) throw new Error(`ShukkaAccess: ${message}`);
}

/**
 * The project's deploy access: three roles a GitHub workflow can assume through OIDC, each trusting only shukka's
 * own nested workflow file (job_workflow_ref) at a tagged version, run for the project's repository on main
 * (infra, app) or for a pull request (diff). The OIDC provider is imported, never created.
 */
export class ShukkaAccess extends Construct {
  readonly infraRole: iam.Role;
  readonly appRole: iam.Role;
  readonly diffRole: iam.Role;

  constructor(scope: Construct, id: string, props: ShukkaAccessProps) {
    super(scope, id);
    const { project, githubRepo } = props;
    const versions = props.shukkaVersions ?? 'v1*';
    const qualifier = props.qualifier ?? project;
    const ssmPath = props.ssmPath ?? `/${project}/prod`;
    const tag = props.instanceTag ?? { key: 'Project', value: project };

    check(PROJECT_RE.test(project), `project must match ${PROJECT_RE}, got ${JSON.stringify(project)}`);
    check(GITHUB_REPO_RE.test(githubRepo) && !githubRepo.split(/[/@]/).some((s) => s === '.' || s === '..'),
      `githubRepo must be owner/repo or owner@id/repo@id, got ${JSON.stringify(githubRepo)}`);
    check(VERSIONS_RE.test(versions), `shukkaVersions must start with a literal character and use only [A-Za-z0-9._*-], got ${JSON.stringify(versions)}`);
    check(QUALIFIER_RE.test(qualifier), `qualifier must match ${QUALIFIER_RE} (pass one when the project name is not a valid qualifier), got ${JSON.stringify(qualifier)}`);
    check(SSM_PATH_RE.test(ssmPath), `ssmPath must be an absolute literal parameter path such as /project/prod, got ${JSON.stringify(ssmPath)}`);
    check(/^[A-Za-z0-9._:/=+@-]{1,128}$/.test(tag.key) && /^[A-Za-z0-9._:/=+@ -]{1,256}$/.test(tag.value),
      'instanceTag key and value must be literal tag strings');
    if (props.allowBranch !== undefined) {
      check(BRANCH_RE.test(props.allowBranch) && !props.allowBranch.includes('..'),
        `allowBranch must be a literal branch name, got ${JSON.stringify(props.allowBranch)}`);
    }

    const stack = Stack.of(this);
    const providerArn = props.oidcProviderArn ?? stack.formatArn({
      service: 'iam', region: '', resource: 'oidc-provider', resourceName: PROVIDER_HOST, arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
    });
    if (props.oidcProviderArn !== undefined && !Token.isUnresolved(props.oidcProviderArn)) {
      check(PROVIDER_ARN_RE.test(props.oidcProviderArn), `oidcProviderArn must be the GitHub Actions provider ARN, got ${JSON.stringify(props.oidcProviderArn)}`);
    }
    const provider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(this, 'GitHubProvider', providerArn);

    const principal = (subject: 'main' | 'pull_request', file: 'infra.yml' | 'ec2.yml'): iam.IPrincipal => {
      const refs = [`${SHUKKA_WORKFLOWS}/${file}@refs/tags/${versions}`];
      if (props.allowBranch !== undefined) refs.push(`${SHUKKA_WORKFLOWS}/${file}@refs/heads/${props.allowBranch}`);
      return new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: {
          [`${PROVIDER_HOST}:aud`]: 'sts.amazonaws.com',
          [`${PROVIDER_HOST}:sub`]: subject === 'main' ? `repo:${githubRepo}:ref:refs/heads/main` : `repo:${githubRepo}:pull_request`,
        },
        StringLike: { [`${PROVIDER_HOST}:job_workflow_ref`]: refs.length === 1 ? refs[0] : refs },
      });
    };

    const arn = (service: string, resource: string, resourceName: string, opts: { region?: string; account?: string } = {}) =>
      stack.formatArn({ service, resource, resourceName, arnFormat: ArnFormat.SLASH_RESOURCE_NAME, ...opts });

    this.infraRole = new iam.Role(this, 'InfraRole', {
      roleName: `${project}-shukka-infra`,
      description: `shukka: ${project} infrastructure deploy from shukka infra.yml on main`,
      assumedBy: principal('main', 'infra.yml'),
      inlinePolicies: {
        deploy: new iam.PolicyDocument({
          statements: [
            // cdk deploys through the project's own bootstrap roles; the fence lives on their execution role.
            new iam.PolicyStatement({
              actions: ['sts:AssumeRole'],
              resources: ['deploy', 'file-publishing', 'lookup'].map((r) => arn('iam', 'role', `cdk-${qualifier}-${r}-role-*`, { region: '' })),
            }),
          ],
        }),
      },
    });

    this.appRole = new iam.Role(this, 'AppRole', {
      roleName: `${project}-shukka-app`,
      description: `shukka: ${project} app release from shukka ec2.yml on main`,
      assumedBy: principal('main', 'ec2.yml'),
      inlinePolicies: {
        release: new iam.PolicyDocument({
          statements: [
            // Upload bundles to s3://<bucket>/<project>/<app>/<sha>.tgz.
            new iam.PolicyStatement({ actions: ['s3:PutObject'], resources: [props.deployBucket.arnForObjects(`${project}/*`)] }),
            // Run the release script: the shell document by ARN, and only on the project's tagged instances.
            new iam.PolicyStatement({ actions: ['ssm:SendCommand'], resources: [arn('ssm', 'document', 'AWS-RunShellScript', { account: '' })] }),
            new iam.PolicyStatement({
              actions: ['ssm:SendCommand'],
              resources: [arn('ec2', 'instance', '*')],
              conditions: { StringEquals: { [`ssm:resourceTag/${tag.key}`]: tag.value } },
            }),
            // Resource '*': neither action supports a resource type (GetCommandInvocation reads by command id,
            // DescribeInstances is list-only).
            new iam.PolicyStatement({ actions: ['ssm:GetCommandInvocation', 'ec2:DescribeInstances'], resources: ['*'] }),
            // Read the project's settings.
            new iam.PolicyStatement({ actions: ['ssm:GetParameter'], resources: [arn('ssm', 'parameter', `${ssmPath.slice(1)}/*`)] }),
          ],
        }),
      },
    });

    const Project = project.charAt(0).toUpperCase() + project.slice(1);
    this.diffRole = new iam.Role(this, 'DiffRole', {
      roleName: `${project}-shukka-diff`,
      description: `shukka: ${project} pull-request diff from shukka infra.yml; reads templates only`,
      assumedBy: principal('pull_request', 'infra.yml'),
      inlinePolicies: {
        diff: new iam.PolicyDocument({
          statements: [
            // Templates and stack status of the project's stacks only. Never the CDK lookup role (D10).
            new iam.PolicyStatement({
              actions: ['cloudformation:GetTemplate', 'cloudformation:DescribeStacks'],
              resources: [project, Project].map((n) => arn('cloudformation', 'stack', `${n}*/*`)),
            }),
            new iam.PolicyStatement({ actions: ['ssm:GetParameter'], resources: [arn('ssm', 'parameter', `cdk-bootstrap/${qualifier}/version`)] }),
          ],
        }),
      },
    });
  }
}
