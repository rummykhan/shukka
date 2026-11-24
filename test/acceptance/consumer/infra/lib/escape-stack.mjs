// Only present while the suite's fence case runs (settings.escape = true). Asks CloudFormation, through
// shukkatest's limited execution role, to change the stand-in "other project": put a policy on its
// bucket and create a queue in its name space. The fence must refuse both and the deploy must fail.
// The bucket policy only denies deleting the bucket, so it would be harmless if it were applied.
import { Stack } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';

export class EscapeStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);
    const s = props.targets.standin;
    new s3.CfnBucketPolicy(this, 'StandinBucketPolicy', {
      bucket: s.bucket,
      policyDocument: {
        Version: '2012-10-17',
        Statement: [{
          Sid: 'ShukkatestEscape',
          Effect: 'Deny',
          Principal: '*',
          Action: 's3:DeleteBucket',
          Resource: `arn:aws:s3:::${s.bucket}`,
        }],
      },
    });
    new sqs.CfnQueue(this, 'StandinQueue', { queueName: s.queue });
  }
}
