// The CI stack (<Project>-Ci, holding ShukkaAccess) deploys with the caller's own credentials, every other stack through
// the project's bootstrap: a consumer's app synthesized for real, then read by the checks the pipeline runs.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App, Stack } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { ShukkaAccess, applyBoundary, shukkaCiSynthesizer, shukkaSynthesizer } from '../lib/index.js';
import { checkAssembly, deployCommands } from '../scripts/assembly.mjs';
import { policyGuard } from '../scripts/policy-guard.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'shu-9bj12-ci-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;

function synthConsumer(ciSynthesizer: (q: string) => unknown = shukkaCiSynthesizer): { dir: string; artifacts: Loose } {
  const dir = mkdtempSync(join(scratch, 'cdk.out-'));
  const app = new App({ outdir: dir });
  const env = { account: '123456789012', region: 'us-east-1' };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ci = new Stack(app, 'Acme-Ci', { env, synthesizer: ciSynthesizer('acme') as any });
  new ShukkaAccess(ci, 'Access', {
    project: 'acme',
    githubRepo: 'acme-org/acme',
    deployBucket: s3.Bucket.fromBucketName(ci, 'DeployBucket', 'acme-deploy-123456789012'),
  });
  const box = new Stack(app, 'Acme-Box', { env, synthesizer: shukkaSynthesizer('acme') });
  new s3.Bucket(box, 'Data', { bucketName: 'acme-data-123456789012', blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, enforceSSL: true });
  applyBoundary(app, 'acme');
  app.synth();
  return { dir, artifacts: JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).artifacts };
}

const deployRole = 'arn:${AWS::Partition}:iam::123456789012:role/cdk-acme-deploy-role-123456789012-us-east-1';

test('shu-9bj.12: synth shows <Project>-Ci with no deploy or execution role, every other stack on the project deploy and execution roles', () => {
  const { artifacts } = synthConsumer();
  const ci = artifacts['Acme-Ci'].properties;
  assert.equal(ci.assumeRoleArn, undefined, 'cdk deploys the CI stack with the caller\'s own credentials');
  assert.equal(ci.cloudFormationExecutionRoleArn, undefined, 'CloudFormation acts as the caller, not the fenced execution role');
  // Diffs read the deployed CI template through the project's deploy role, as for every other stack (shukkaSynthesizer).
  assert.deepEqual(ci.lookupRole, { arn: 'arn:${AWS::Partition}:iam::${AWS::AccountId}:role/cdk-acme-deploy-role-${AWS::AccountId}-${AWS::Region}', requiresBootstrapStackVersion: 8, bootstrapStackVersionSsmParameter: '/cdk-bootstrap/acme/version' });
  // Its template goes to the project's bootstrap bucket, with no role to assume for publishing either.
  assert.match(ci.stackTemplateAssetObjectUrl, /^s3:\/\/cdk-acme-assets-123456789012-us-east-1\//);
  const box = artifacts['Acme-Box'].properties;
  assert.equal(box.assumeRoleArn, deployRole);
  assert.equal(box.cloudFormationExecutionRoleArn, 'arn:${AWS::Partition}:iam::123456789012:role/cdk-acme-cfn-exec-role-123456789012-us-east-1');
  assert.equal(box.lookupRole.arn, deployRole);
});

test('shu-9bj.12: the pipeline\'s checks accept the synthesized CI stack, and its deploy commands leave it out', () => {
  const { dir, artifacts } = synthConsumer();
  assert.deepEqual(checkAssembly(dir, { project: 'acme' }), []);
  const guarded = policyGuard(dir, { account: '123456789012', repos: ['acme-org/acme'], mailDomains: [], allow: false });
  assert.equal(guarded.code, 0, JSON.stringify(guarded));
  const plan = deployCommands(artifacts, 'acme', 'abc1234');
  assert.deepEqual(plan.skipped, ['Acme-Ci']);
  assert.ok(plan.commands.every((args) => args.includes('--exclusively') && !args.includes('Acme-Ci') && !args.includes('--all')), JSON.stringify(plan.commands));
  assert.deepEqual(plan.commands.flat().filter((a) => !a.startsWith('--')), ['Acme-Box']);
});

test('shu-9bj.12: the CI synthesizer on any stack but <Project>-Ci is refused', () => {
  const dir = mkdtempSync(join(scratch, 'cdk.out-'));
  const app = new App({ outdir: dir });
  new Stack(app, 'Acme-Box', { env: { account: '123456789012', region: 'us-east-1' }, synthesizer: shukkaCiSynthesizer('acme') });
  app.synth();
  assert.match(checkAssembly(dir, { project: 'acme' }).join('\n'), /stack Acme-Box names no assumeRoleArn and no cloudFormationExecutionRoleArn: only Acme-Ci may/);
});
