// Synthesizes a ShukkaBoundary in a stack and reads the three managed policies back out of the template, so tests
// and the simulator check what the construct actually emits.
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { ShukkaBoundary, boundaryPolicyName, executionPolicyNames, type PolicyDocumentJson } from '../../lib/boundary.js';

export interface SynthInputs {
  project: string;
  account: string;
  region: string;
  qualifier?: string;
  hostedZoneId: string;
  sesDomains: string[];
}

export interface SynthesizedFence {
  executionA: PolicyDocumentJson;
  executionB: PolicyDocumentJson;
  boundary: PolicyDocumentJson;
}

export function synthFence(inputs: SynthInputs): SynthesizedFence {
  const app = new App();
  const stack = new Stack(app, 'Fence', { env: { account: inputs.account, region: inputs.region } });
  new ShukkaBoundary(stack, 'Boundary', {
    project: inputs.project,
    qualifier: inputs.qualifier,
    hostedZoneId: inputs.hostedZoneId,
    sesDomains: inputs.sesDomains,
  });
  const policies = Template.fromStack(stack).findResources('AWS::IAM::ManagedPolicy');
  const byName = new Map<string, PolicyDocumentJson>();
  for (const res of Object.values(policies)) {
    const props = res.Properties as { ManagedPolicyName: string; PolicyDocument: PolicyDocumentJson };
    byName.set(props.ManagedPolicyName, props.PolicyDocument);
  }
  const get = (name: string): PolicyDocumentJson => {
    const doc = byName.get(name);
    if (!doc) throw new Error(`no managed policy named ${name} in the template`);
    return doc;
  };
  const [a, b] = executionPolicyNames(inputs.project);
  return { executionA: get(a), executionB: get(b), boundary: get(boundaryPolicyName(inputs.project)) };
}
