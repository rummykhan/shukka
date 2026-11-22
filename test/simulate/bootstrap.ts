// Reads the bootstrap template's deploy and file-publishing role policies and resolves the pseudo parameters, so the
// simulator checks what the template actually holds.
import { bootstrapTemplate } from '../../lib/bootstrap.js';
import type { PolicyDocumentJson } from '../../lib/boundary.js';

export interface BootstrapPolicies {
  deploy: PolicyDocumentJson;
  filePublishing: PolicyDocumentJson;
  /**
   * The deploy and file-publishing roles' trust statements in identity-policy form (Principal dropped, Resource the
   * role): the simulator does not evaluate role trust policies, but this lets it evaluate their aws:PrincipalArn
   * condition. The Principal is the account itself in both.
   */
  deployTrust: PolicyDocumentJson;
  filePublishingTrust: PolicyDocumentJson;
}

export function synthBootstrap(inputs: { project: string; qualifier?: string; account: string; region: string; emergencyPrincipals?: string[] }): BootstrapPolicies {
  const pseudo = (s: string) => s.replaceAll('${AWS::AccountId}', inputs.account).replaceAll('${AWS::Region}', inputs.region).replaceAll('${AWS::Partition}', 'aws');
  const resolve = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(resolve);
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (typeof o['Fn::Sub'] === 'string') return pseudo(o['Fn::Sub']);
      if (o.Ref === 'AWS::AccountId') return inputs.account;
      return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, resolve(x)]));
    }
    return v;
  };
  const resources = bootstrapTemplate(inputs).Resources as Record<string, {
    Properties: { RoleName: unknown; Policies: { PolicyDocument: unknown }[]; AssumeRolePolicyDocument: { Statement: Record<string, unknown>[] } };
  }>;
  const trust = (id: string) => {
    const props = resources[id]!.Properties;
    const roleArn = `arn:aws:iam::${inputs.account}:role/${resolve(props.RoleName) as string}`;
    const Statement = props.AssumeRolePolicyDocument.Statement.map((st) => {
      const { Principal, ...rest } = resolve(st) as Record<string, unknown>;
      if (JSON.stringify(Principal) !== JSON.stringify({ AWS: inputs.account })) throw new Error(`${id}: unexpected trust principal`);
      return { ...rest, Resource: roleArn };
    });
    return { Version: '2012-10-17', Statement } as PolicyDocumentJson;
  };
  const doc = (id: string) => {
    const policies = resources[id]?.Properties.Policies;
    if (policies?.length !== 1) throw new Error(`expected one inline policy on ${id}`);
    return resolve(policies[0]!.PolicyDocument) as PolicyDocumentJson;
  };
  return {
    deploy: doc('DeploymentActionRole'), filePublishing: doc('FilePublishingRole'),
    deployTrust: trust('DeploymentActionRole'), filePublishingTrust: trust('FilePublishingRole'),
  };
}
