import { DefaultStackSynthesizer } from 'aws-cdk-lib';

/**
 * A stack synthesizer that deploys through the project's own CDK bootstrap (its qualifier), so CloudFormation runs
 * with the project's limited execution role instead of the account's default bootstrap. In shukka the qualifier is
 * the project name.
 */
export function shukkaSynthesizer(qualifier: string): DefaultStackSynthesizer {
  return new DefaultStackSynthesizer({ qualifier });
}
