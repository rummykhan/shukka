// The AWS reads the CLI makes, behind one interface so tests replace it whole (they never call AWS).
// Writes are never made here: they go through the printed commands (cdk, aws cloudformation deploy, gh) and the
// shared upload and release modules.

import {
  CloudFormationClient,
  DescribeStacksCommand,
  DescribeTypeCommand,
  ListStackResourcesCommand,
  ListStacksCommand,
  ListTypesCommand,
} from '@aws-sdk/client-cloudformation';
import { EC2Client } from '@aws-sdk/client-ec2';
import {
  GetPolicyVersionCommand,
  GetRoleCommand,
  IAMClient,
  ListOpenIDConnectProvidersCommand,
  ListPoliciesCommand,
  ListRolesCommand,
} from '@aws-sdk/client-iam';
import { S3Client } from '@aws-sdk/client-s3';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { CliError } from './exec.mjs';

/**
 * @typedef {{ name: string, outputs: Record<string, string>, tags: Record<string, string> }} StackInfo
 * @typedef {{ kind: string, typeName: string, executionRoleArn: string | null }} PrivateType
 * @typedef {{ roleName: string, arn: string, boundaryArn?: string }} UnboundedRole
 * @typedef {{ send(command: any): Promise<any> }} Client
 * @typedef {{ name: string, arn: string, defaultVersionId: string }} LocalPolicy
 * @typedef {{ accessKeyId: string, secretAccessKey: string, sessionToken: string }} Session
 * @typedef {{
 *   callerArn: () => Promise<{ account: string, arn: string }>,
 *   roleArn: (roleName: string) => Promise<string>,
 *   describeStack: (name: string) => Promise<StackInfo | null>,
 *   stackResourceIds: (name: string) => Promise<string[]>,
 *   listStackNames: (prefix: string) => Promise<string[]>,
 *   getParameter: (name: string) => Promise<{ type: string, value: string } | null>,
 *   privateTypes: () => Promise<PrivateType[]>,
 *   unboundedRoles: (project: string) => Promise<UnboundedRole[]>,
 *   oidcProviders: () => Promise<string[]>,
 *   hostedZoneName: (id: string) => Promise<string>,
 *   localPolicies: () => Promise<LocalPolicy[]>,
 *   policyDocument: (policy: LocalPolicy) => Promise<string>,
 *   assumeRole: (roleArn: string, sessionName: string) => Promise<Session>,
 *   clients: () => { s3: Client, ssm: Client, ec2: Client },
 * }} Aws
 */

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function notFound(error) {
  const e = /** @type {{ name?: string, message?: string }} */ (error);
  return e.name === 'ParameterNotFound' || e.name === 'NoSuchEntity' || /does not exist/.test(e.message ?? '');
}

/**
 * The real reads, with the caller's profile (or the default credential chain) and region.
 * @param {{ profile?: string, region: string, io: import('./exec.mjs').Io }} options
 * @returns {Aws}
 */
export function realAws({ profile, region, io }) {
  const config = { region, ...(profile ? { profile } : {}) };
  const cfn = new CloudFormationClient(config);
  const ssm = new SSMClient(config);
  const iam = new IAMClient(config);

  const cliArgs = ['--output', 'json', '--region', region, ...(profile ? ['--profile', profile] : [])];

  /** @type {Aws} */
  const aws = {
    async callerArn() {
      // STS through the AWS CLI: read-only, and it resolves the same profile the printed commands use.
      const args = ['sts', 'get-caller-identity', '--output', 'json', '--region', region, ...(profile ? ['--profile', profile] : [])];
      const r = io.run('aws', args, { mutates: false, capture: 'stdout' });
      if (r.status !== 0) throw new CliError('cannot read the caller identity (aws sts get-caller-identity failed)');
      const id = JSON.parse(r.stdout);
      return { account: String(id.Account), arn: String(id.Arn) };
    },
    async roleArn(roleName) {
      const r = await iam.send(new GetRoleCommand({ RoleName: roleName }));
      return String(r.Role?.Arn ?? '');
    },
    async describeStack(name) {
      try {
        const r = await cfn.send(new DescribeStacksCommand({ StackName: name }));
        const s = r.Stacks?.[0];
        if (!s || s.StackStatus === 'DELETE_COMPLETE') return null;
        return {
          name,
          outputs: Object.fromEntries((s.Outputs ?? []).map((/** @type {any} */ o) => [o.OutputKey, o.OutputValue])),
          tags: Object.fromEntries((s.Tags ?? []).map((/** @type {any} */ t) => [t.Key, t.Value])),
        };
      } catch (error) {
        if (notFound(error)) return null;
        throw error;
      }
    },
    async stackResourceIds(name) {
      /** @type {string[]} */
      const ids = [];
      /** @type {string | undefined} */
      let token;
      do {
        const r = await cfn.send(new ListStackResourcesCommand({ StackName: name, ...(token ? { NextToken: token } : {}) }));
        for (const s of r.StackResourceSummaries ?? []) if (s.LogicalResourceId) ids.push(s.LogicalResourceId);
        token = r.NextToken;
      } while (token);
      return ids;
    },
    async listStackNames(prefix) {
      /** @type {string[]} */
      const names = [];
      /** @type {string | undefined} */
      let token;
      do {
        const r = await cfn.send(new ListStacksCommand({ ...(token ? { NextToken: token } : {}) }));
        for (const s of r.StackSummaries ?? []) {
          if (s.StackName?.startsWith(prefix) && s.StackStatus !== 'DELETE_COMPLETE') names.push(s.StackName);
        }
        token = r.NextToken;
      } while (token);
      return names;
    },
    async getParameter(name) {
      try {
        const r = await ssm.send(new GetParameterCommand({ Name: name }));
        return { type: String(r.Parameter?.Type ?? ''), value: String(r.Parameter?.Value ?? '') };
      } catch (error) {
        if (notFound(error)) return null;
        throw error;
      }
    },
    async privateTypes() {
      /** @type {PrivateType[]} */
      const found = [];
      for (const kind of ['RESOURCE', 'MODULE', 'HOOK']) {
        /** @type {string | undefined} */
        let token;
        do {
          const r = await cfn.send(new ListTypesCommand({ Visibility: 'PRIVATE', Type: /** @type {any} */ (kind), ...(token ? { NextToken: token } : {}) }));
          for (const t of r.TypeSummaries ?? []) {
            if (!t.TypeName) continue;
            const d = await cfn.send(new DescribeTypeCommand({ Type: /** @type {any} */ (kind), TypeName: t.TypeName }));
            found.push({ kind, typeName: t.TypeName, executionRoleArn: d.ExecutionRoleArn ?? null });
          }
          token = r.NextToken;
        } while (token);
      }
      return found;
    },
    async unboundedRoles(project) {
      const { unboundedRoles } = await import('../../lib/unbounded-roles.js');
      return unboundedRoles({
        listRoles: (input) => iam.send(new ListRolesCommand(input)),
        getRole: (input) => iam.send(new GetRoleCommand(input)),
      }, project);
    },
    async oidcProviders() {
      const r = await iam.send(new ListOpenIDConnectProvidersCommand({}));
      return (r.OpenIDConnectProviderList ?? []).map((/** @type {any} */ p) => String(p.Arn ?? ''));
    },
    async hostedZoneName(id) {
      // Route 53 through the AWS CLI (read-only), as STS: no extra SDK client for one call.
      const r = io.run('aws', ['route53', 'get-hosted-zone', '--id', id, ...cliArgs], { mutates: false, capture: 'stdout' });
      if (r.status !== 0) throw new CliError(`cannot read hosted zone ${id} (aws route53 get-hosted-zone failed); is it in this account?`);
      return String(JSON.parse(r.stdout).HostedZone?.Name ?? '');
    },
    async localPolicies() {
      /** @type {LocalPolicy[]} */
      const found = [];
      /** @type {string | undefined} */
      let marker;
      do {
        const r = await iam.send(new ListPoliciesCommand({ Scope: 'Local', ...(marker ? { Marker: marker } : {}) }));
        for (const p of r.Policies ?? []) {
          if (p.PolicyName && p.Arn) found.push({ name: p.PolicyName, arn: p.Arn, defaultVersionId: String(p.DefaultVersionId ?? '') });
        }
        marker = r.IsTruncated ? r.Marker : undefined;
      } while (marker);
      return found;
    },
    async policyDocument(policy) {
      const r = await iam.send(new GetPolicyVersionCommand({ PolicyArn: policy.arn, VersionId: policy.defaultVersionId }));
      return decodeURIComponent(String(r.PolicyVersion?.Document ?? ''));
    },
    async assumeRole(roleArn, sessionName) {
      // The output holds the session's keys: captured, never printed.
      const r = io.run('aws', ['sts', 'assume-role', '--role-arn', roleArn, '--role-session-name', sessionName, ...cliArgs], { mutates: false, capture: 'stdout' });
      if (r.status !== 0) throw new CliError(`cannot assume ${roleArn}; is your principal one of the project's emergency principals (shukka bootstrap --emergency-principal)?`);
      const c = JSON.parse(r.stdout).Credentials ?? {};
      return { accessKeyId: String(c.AccessKeyId), secretAccessKey: String(c.SecretAccessKey), sessionToken: String(c.SessionToken) };
    },
    clients() {
      return { s3: new S3Client(config), ssm, ec2: new EC2Client(config) };
    },
  };
  return aws;
}
