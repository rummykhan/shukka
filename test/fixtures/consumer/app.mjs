// A consumer's CDK app that takes shukka's constructs from the package entry point and the documented deep path
// (test/access.test.ts copies this next to a node_modules holding shukka and runs it under tsx).
import { App, Stack } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { ShukkaAccess, applyBoundary } from 'shukka';
import * as deep from 'shukka/lib/index.ts';

const app = new App();
const stack = new Stack(app, 'Consumer-Ci', { env: { account: '123456789012', region: 'us-east-1' } });
new ShukkaAccess(stack, 'Access', {
  project: 'consumer',
  githubRepo: 'example/consumer',
  deployBucket: s3.Bucket.fromBucketName(stack, 'Bucket', 'consumer-deploy'),
});
const template = app.synth().getStackByName('Consumer-Ci').template;
const roles = Object.values(template.Resources)
  .filter((r) => r.Type === 'AWS::IAM::Role')
  .map((r) => r.Properties.RoleName)
  .sort();
console.log(JSON.stringify({ roles, boundary: typeof applyBoundary, deepPathSameClass: deep.ShukkaAccess === ShukkaAccess }));
