import { CliCredentialsStackSynthesizer, DefaultStackSynthesizer, type ISynthesisSession, type SynthesizeStackArtifactOptions } from 'aws-cdk-lib';

/** The project's deploy role, standing in for the lookup role shukka's bootstrap does not create. */
const deployRoleArn = (qualifier: string) =>
  `arn:\${AWS::Partition}:iam::\${AWS::AccountId}:role/cdk-${qualifier}-deploy-role-\${AWS::AccountId}-\${AWS::Region}`;

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

/**
 * The synthesizer of the CI stack (`<Project>-Ci`, the one holding ShukkaAccess) and of no other stack.
 *
 * The execution role may never change the CI roles (the fence's NoChangeToCiRoles: a merge must not re-trust or widen
 * the roles the pipeline runs as), so the CI stack cannot deploy through it: CloudFormation would create the roles and
 * then be refused their inline policies. This synthesizer names no deploy role and no execution role, so `cdk deploy`
 * runs CloudFormation with the caller's own credentials: an admin's, by hand (README step 5). The template is
 * published to the project's bootstrap bucket with those credentials too. The pipeline and `shukka deploy` never
 * deploy this stack (scripts/assembly.mjs deployCommands); scripts/assembly.mjs refuses this kind of stack under any
 * other name.
 *
 * Diffs still read the deployed template through the project's deploy role (as shukkaSynthesizer's lookup role), so
 * the pipeline's diff, which holds only the infra role, shows the CI stack's changes too.
 */
export class ShukkaCiSynthesizer extends CliCredentialsStackSynthesizer {
  private readonly lookupQualifier: string;

  constructor(qualifier: string) {
    super({ qualifier });
    this.lookupQualifier = qualifier;
  }

  protected override emitArtifact(session: ISynthesisSession, options: SynthesizeStackArtifactOptions = {}): void {
    super.emitArtifact(session, {
      ...options,
      lookupRole: {
        arn: deployRoleArn(this.lookupQualifier),
        requiresBootstrapStackVersion: 8,
        bootstrapStackVersionSsmParameter: `/cdk-bootstrap/${this.lookupQualifier}/version`,
      },
    });
  }
}

/** The CI stack's synthesizer (see ShukkaCiSynthesizer); pass the same qualifier as to shukkaSynthesizer. */
export function shukkaCiSynthesizer(qualifier: string): ShukkaCiSynthesizer {
  return new ShukkaCiSynthesizer(qualifier);
}
