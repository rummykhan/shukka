import { CfnOutput, CfnWaitConditionHandle, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

export const GITHUB_OIDC_URL = 'https://token.actions.githubusercontent.com';
export const GITHUB_OIDC_CLIENT_ID = 'sts.amazonaws.com';

export interface ShukkaAccountStackProps extends StackProps {
  /** Names of the projects bootstrapped in this account; the config validator refuses a name that prefixes another. */
  readonly projects: readonly string[];
  /** Use the account's existing GitHub OIDC provider instead of creating one. */
  readonly existingOidcProviderArn?: string;
}

/**
 * `Shukka-Account`: deployed once per AWS account with admin credentials (`shukka bootstrap --account`). Owns the
 * GitHub OIDC provider, which belongs to the account rather than any project (spike S2, finding 3); projects import
 * it by ARN. Outputs the provider's ARN and the known project names.
 */
export class ShukkaAccountStack extends Stack {
  readonly oidcProviderArn: string;

  constructor(scope: Construct, id = 'Shukka-Account', props: ShukkaAccountStackProps) {
    super(scope, id, props);
    if (props.existingOidcProviderArn) {
      // Refer to the provider without owning it. CloudFormation refuses a template with no resources, so the stack
      // holds an empty placeholder (free, does nothing).
      this.oidcProviderArn = props.existingOidcProviderArn;
      new CfnWaitConditionHandle(this, 'Placeholder');
    } else {
      // The native CloudFormation resource, not CDK's custom-resource provider, whose Lambda would need
      // account-wide rights on OIDC providers. No thumbprints: IAM verifies GitHub's certificate itself.
      const provider = new iam.CfnOIDCProvider(this, 'GitHubOidcProvider', {
        url: GITHUB_OIDC_URL,
        clientIdList: [GITHUB_OIDC_CLIENT_ID],
      });
      // Every project's roles trust it: never delete it with the stack. Retained, the resource can also adopt a
      // provider that already exists (`cdk import`), as in Trendigle's migration out of its Ci stack.
      provider.applyRemovalPolicy(RemovalPolicy.RETAIN);
      this.oidcProviderArn = provider.attrArn;
    }
    new CfnOutput(this, 'OidcProviderArn', { value: this.oidcProviderArn, description: 'GitHub OIDC provider; projects import it by ARN' });
    // Comma-separated; CloudFormation refuses an empty output value, so an account with no projects yet says "none".
    new CfnOutput(this, 'Projects', {
      value: props.projects.length > 0 ? props.projects.join(',') : 'none',
      description: 'Projects bootstrapped in this account, comma-separated',
    });
  }
}
