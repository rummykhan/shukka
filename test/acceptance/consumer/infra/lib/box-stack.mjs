// The throwaway server stack: an instance with an elastic IP, security group, launch template
// (IMDSv2), role and instance profile, a table, the deploy bucket, and a DNS record in the
// throwaway hosted zone. Uses the default VPC by id so no context lookup is needed.
import { CfnOutput, Duration, Stack } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as s3 from 'aws-cdk-lib/aws-s3';

export class BoxStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);
    const e = props.shukkatest;
    const settings = props.settings;

    const vpc = ec2.Vpc.fromVpcAttributes(this, 'Vpc', {
      vpcId: e.vpcId,
      availabilityZones: [e.availabilityZone],
      publicSubnetIds: [e.subnetId],
    });

    const bucket = new s3.Bucket(this, 'DeployBucket', {
      bucketName: `shukkatest-deploy-${e.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [{ prefix: 'shukkatest/', expiration: Duration.days(30) }],
    });

    new dynamodb.Table(this, 'Items', {
      tableName: settings.tableName,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    const role = new iam.Role(this, 'BoxRole', {
      roleName: 'shukkatest-box',
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
    });
    bucket.grantRead(role, 'shukkatest/*');

    const sg = new ec2.SecurityGroup(this, 'BoxSg', {
      vpc,
      securityGroupName: 'shukkatest-box',
      description: 'shukkatest acceptance box: the two test apps',
      allowAllOutbound: true,
    });
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(8080), 'web');
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(8081), 'api');

    const box = new ec2.Instance(this, 'Box', {
      vpc,
      vpcSubnets: { subnets: vpc.publicSubnets },
      instanceName: 'shukkatest-box',
      instanceType: new ec2.InstanceType('t4g.nano'),
      machineImage: ec2.MachineImage.genericLinux({ [e.region]: e.amiId }),
      securityGroup: sg,
      role,
      requireImdsv2: true,
    });

    const ip = new ec2.CfnEIP(this, 'BoxIp', { domain: 'vpc' });
    new ec2.CfnEIPAssociation(this, 'BoxIpAssociation', { allocationId: ip.attrAllocationId, instanceId: box.instanceId });

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
      hostedZoneId: e.hostedZoneId,
      zoneName: e.zoneName,
    });
    new route53.ARecord(this, 'BoxRecord', {
      zone,
      recordName: 'box',
      target: route53.RecordTarget.fromIpAddresses(ip.ref),
      ttl: Duration.minutes(1),
    });

    new CfnOutput(this, 'PublicIp', { value: ip.ref });
    new CfnOutput(this, 'InstanceId', { value: box.instanceId });
    if (settings.note) new CfnOutput(this, 'Note', { value: settings.note });
  }
}
