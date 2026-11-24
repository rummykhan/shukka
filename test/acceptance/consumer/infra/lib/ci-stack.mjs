// The project's CI stack: shukka's deploy access (infra, app and diff roles). Deployed once by hand
// with admin credentials before the first merge (a pipeline cannot create the role it runs as).
import { Stack } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { ShukkaAccess } from 'shukka';

export class CiStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);
    const e = props.shukkatest;
    new ShukkaAccess(this, 'Access', {
      project: 'shukkatest',
      githubRepo: e.githubRepoSubject,
      oidcProviderArn: e.oidcProviderArn,
      deployBucket: s3.Bucket.fromBucketName(this, 'DeployBucket', `shukkatest-deploy-${e.account}`),
      // The suite calls shukka at a release-candidate tag (v1.0.0-rc.N), which production trust refuses. Its runs
      // reference shukka's workflows only by that tag, so no allowBranch.
      allowPrerelease: true,
    });
  }
}
