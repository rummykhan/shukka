import { DefaultStackSynthesizer } from 'aws-cdk-lib';

/**
 * A stack synthesizer that deploys through the project's own CDK bootstrap (its qualifier), so CloudFormation runs
 * with the project's limited execution role instead of the account's default bootstrap. In shukka the qualifier is
 * the project name.
 *
 * shukka's bootstrap has no lookup role (lib/bootstrap.ts). `cdk diff` and `cdk deploy` read the deployed template
 * through the lookup role, so it is the project's deploy role here: that role may DescribeStacks and GetTemplate on
 * the project's stacks and read the bootstrap version, which is all those reads need.
 */
export function shukkaSynthesizer(qualifier: string): DefaultStackSynthesizer {
  return new DefaultStackSynthesizer({
    qualifier,
    lookupRoleArn: 'arn:${AWS::Partition}:iam::${AWS::AccountId}:role/cdk-${Qualifier}-deploy-role-${AWS::AccountId}-${AWS::Region}',
  });
}
