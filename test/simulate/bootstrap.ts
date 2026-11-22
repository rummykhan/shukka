// Reads the bootstrap template's deploy and file-publishing role policies and resolves the pseudo parameters, so the
// simulator checks what the template actually holds.
import { bootstrapTemplate } from '../../lib/bootstrap.js';
import type { PolicyDocumentJson } from '../../lib/boundary.js';

export interface BootstrapPolicies {
  deploy: PolicyDocumentJson;
  filePublishing: PolicyDocumentJson;
}

export function synthBootstrap(inputs: { project: string; qualifier?: string; account: string; region: string }): BootstrapPolicies {
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
  const resources = bootstrapTemplate(inputs).Resources as Record<string, { Properties: { Policies: { PolicyDocument: unknown }[] } }>;
  const doc = (id: string) => {
    const policies = resources[id]?.Properties.Policies;
    if (policies?.length !== 1) throw new Error(`expected one inline policy on ${id}`);
    return resolve(policies[0]!.PolicyDocument) as PolicyDocumentJson;
  };
  return { deploy: doc('DeploymentActionRole'), filePublishing: doc('FilePublishingRole') };
}
