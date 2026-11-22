"""Spike S2: draft execution policy and permissions boundary for one project.
Usage: python3 policy.py <project> <account> <region> <qualifier> <hosted-zone-id> <ses-domain>... > out.json
Prints {"execution": {...}, "boundary": {...}}. The construct in lib/ will produce the same documents."""
import json, sys

project, account, region, qualifier, zone, *ses = sys.argv[1:]
P = project
Pc = project[:1].upper() + project[1:]            # CDK stack-generated names start with the stack name
# Project names must not be prefixes of one another (trendigle vs trendiglepro): the fence is a name prefix.
names = [f"{P}*", f"{Pc}*"]
boundary_arn = f"arn:aws:iam::{account}:policy/{P}-shukka-boundary"
exec_arn = f"arn:aws:iam::{account}:policy/{P}-shukka-execution"

def arns(fmt):
    return [fmt.format(n=n) for n in names]

def resource_statements():
    """Everything a project's own resources may have done to them (shared by execution policy and boundary)."""
    tbl = arns(f"arn:aws:dynamodb:{region}:{account}:table/{{n}}")
    return [
        {"Sid": "DynamoDB", "Effect": "Allow", "Action": "dynamodb:*", "Resource": tbl + [t + "/*" for t in tbl]},
        {"Sid": "S3", "Effect": "Allow", "Action": "s3:*", "Resource": arns("arn:aws:s3:::{n}") + arns("arn:aws:s3:::{n}/*")},
        {"Sid": "Lambda", "Effect": "Allow", "Action": "lambda:*", "Resource": arns(f"arn:aws:lambda:{region}:{account}:function:{{n}}") + arns(f"arn:aws:lambda:{region}:{account}:function:{{n}}:*")},
        {"Sid": "LambdaEventSources", "Effect": "Allow", "Action": ["lambda:CreateEventSourceMapping", "lambda:UpdateEventSourceMapping", "lambda:DeleteEventSourceMapping", "lambda:GetEventSourceMapping", "lambda:ListEventSourceMappings"], "Resource": "*"},
        {"Sid": "SQS", "Effect": "Allow", "Action": "sqs:*", "Resource": arns(f"arn:aws:sqs:{region}:{account}:{{n}}")},
        {"Sid": "SNS", "Effect": "Allow", "Action": "sns:*", "Resource": arns(f"arn:aws:sns:{region}:{account}:{{n}}")},
        {"Sid": "Alarms", "Effect": "Allow", "Action": "cloudwatch:*", "Resource": arns(f"arn:aws:cloudwatch:{region}:{account}:alarm:{{n}}")},
        {"Sid": "Logs", "Effect": "Allow", "Action": "logs:*", "Resource": arns(f"arn:aws:logs:{region}:{account}:log-group:{{n}}") + arns(f"arn:aws:logs:{region}:{account}:log-group:{{n}}:*") + arns(f"arn:aws:logs:{region}:{account}:log-group:/aws/lambda/{{n}}") + arns(f"arn:aws:logs:{region}:{account}:log-group:/aws/lambda/{{n}}:*")},
        {"Sid": "Parameters", "Effect": "Allow", "Action": "ssm:*", "Resource": [f"arn:aws:ssm:{region}:{account}:parameter/{P}", f"arn:aws:ssm:{region}:{account}:parameter/{P}/*"]},
        {"Sid": "DNS", "Effect": "Allow", "Action": ["route53:ChangeResourceRecordSets", "route53:GetHostedZone", "route53:ListResourceRecordSets", "route53:ChangeTagsForResource", "route53:ListTagsForResource"], "Resource": f"arn:aws:route53:::hostedzone/{zone}"},
        {"Sid": "DNSChanges", "Effect": "Allow", "Action": ["route53:GetChange"], "Resource": "arn:aws:route53:::change/*"},
        {"Sid": "SES", "Effect": "Allow", "Action": "ses:*", "Resource": [f"arn:aws:ses:{region}:{account}:identity/{d}" for d in ses] + arns(f"arn:aws:ses:{region}:{account}:configuration-set/{{n}}")},
        # EC2: tag-based. Reads are free; creating needs the project tag on the request; changing needs it on the resource.
        {"Sid": "EC2Read", "Effect": "Allow", "Action": ["ec2:Describe*", "ec2:Get*"], "Resource": "*"},
        {"Sid": "EC2CreateTagged", "Effect": "Allow", "Action": ["ec2:RunInstances", "ec2:CreateSecurityGroup", "ec2:CreateLaunchTemplate", "ec2:AllocateAddress", "ec2:CreateVolume"], "Resource": "*", "Condition": {"StringEquals": {"aws:RequestTag/Project": P}}},
        {"Sid": "EC2RunInstancesSupporting", "Effect": "Allow", "Action": ["ec2:RunInstances", "ec2:CreateSecurityGroup"], "Resource": [f"arn:aws:ec2:{region}::image/*", f"arn:aws:ec2:{region}:{account}:subnet/*", f"arn:aws:ec2:{region}:{account}:vpc/*", f"arn:aws:ec2:{region}:{account}:network-interface/*", f"arn:aws:ec2:{region}:{account}:volume/*", f"arn:aws:ec2:{region}:{account}:security-group/*", f"arn:aws:ec2:{region}:{account}:launch-template/*", f"arn:aws:ec2:{region}:{account}:key-pair/*"]},
        {"Sid": "EC2TagOnCreate", "Effect": "Allow", "Action": "ec2:CreateTags", "Resource": "*", "Condition": {"StringEquals": {"ec2:CreateAction": ["RunInstances", "CreateSecurityGroup", "CreateLaunchTemplate", "AllocateAddress", "CreateVolume"]}}},
        {"Sid": "EC2ChangeOwn", "Effect": "Allow", "Action": ["ec2:CreateTags", "ec2:DeleteTags", "ec2:ModifyInstanceAttribute", "ec2:TerminateInstances", "ec2:StopInstances", "ec2:StartInstances", "ec2:RebootInstances", "ec2:AssociateAddress", "ec2:DisassociateAddress", "ec2:ReleaseAddress", "ec2:AuthorizeSecurityGroupIngress", "ec2:AuthorizeSecurityGroupEgress", "ec2:RevokeSecurityGroupIngress", "ec2:RevokeSecurityGroupEgress", "ec2:UpdateSecurityGroupRuleDescriptionsIngress", "ec2:UpdateSecurityGroupRuleDescriptionsEgress", "ec2:DeleteSecurityGroup", "ec2:CreateLaunchTemplateVersion", "ec2:ModifyLaunchTemplate", "ec2:DeleteLaunchTemplate", "ec2:DeleteLaunchTemplateVersions", "ec2:AssociateIamInstanceProfile", "ec2:ReplaceIamInstanceProfileAssociation", "ec2:DisassociateIamInstanceProfile", "ec2:AttachVolume", "ec2:DetachVolume", "ec2:DeleteVolume", "ec2:ModifyInstanceMetadataOptions"], "Resource": "*", "Condition": {"StringEquals": {"aws:ResourceTag/Project": P}}},
        {"Sid": "EC2AssociateToOwnInstance", "Effect": "Allow", "Action": ["ec2:AssociateAddress", "ec2:AssociateIamInstanceProfile", "ec2:ReplaceIamInstanceProfileAssociation"], "Resource": [f"arn:aws:ec2:{region}:{account}:elastic-ip/*", f"arn:aws:ec2:{region}:{account}:network-interface/*"]},
        # IAM: own roles and instance profiles; new or changed roles must carry the boundary.
        {"Sid": "IAMOwnRoles", "Effect": "Allow", "Action": ["iam:GetRole", "iam:TagRole", "iam:UntagRole", "iam:DeleteRole", "iam:UpdateRole", "iam:UpdateRoleDescription", "iam:UpdateAssumeRolePolicy", "iam:DeleteRolePolicy", "iam:DetachRolePolicy", "iam:GetRolePolicy", "iam:ListRolePolicies", "iam:ListAttachedRolePolicies", "iam:ListInstanceProfilesForRole", "iam:ListRoleTags"], "Resource": arns(f"arn:aws:iam::{account}:role/{{n}}")},
        {"Sid": "IAMBoundedWrites", "Effect": "Allow", "Action": ["iam:CreateRole", "iam:PutRolePolicy", "iam:AttachRolePolicy", "iam:PutRolePermissionsBoundary"], "Resource": arns(f"arn:aws:iam::{account}:role/{{n}}"), "Condition": {"StringEquals": {"iam:PermissionsBoundary": boundary_arn}}},
        {"Sid": "IAMPassOwnRoles", "Effect": "Allow", "Action": "iam:PassRole", "Resource": arns(f"arn:aws:iam::{account}:role/{{n}}"), "Condition": {"StringEquals": {"iam:PassedToService": ["ec2.amazonaws.com", "lambda.amazonaws.com"]}}},
        {"Sid": "IAMInstanceProfiles", "Effect": "Allow", "Action": ["iam:CreateInstanceProfile", "iam:DeleteInstanceProfile", "iam:GetInstanceProfile", "iam:AddRoleToInstanceProfile", "iam:RemoveRoleFromInstanceProfile", "iam:TagInstanceProfile", "iam:UntagInstanceProfile"], "Resource": arns(f"arn:aws:iam::{account}:instance-profile/{{n}}")},
        {"Sid": "IAMReadOIDC", "Effect": "Allow", "Action": ["iam:GetOpenIDConnectProvider"], "Resource": f"arn:aws:iam::{account}:oidc-provider/token.actions.githubusercontent.com"},
        {"Sid": "NoEscapeFromBoundary", "Effect": "Deny", "Action": ["iam:DeleteRolePermissionsBoundary", "iam:CreatePolicyVersion", "iam:DeletePolicy", "iam:DeletePolicyVersion", "iam:SetDefaultPolicyVersion"], "Resource": [boundary_arn, exec_arn] + arns(f"arn:aws:iam::{account}:role/{{n}}")},
    ]

def data_statements():
    """What roles the project creates (servers, Lambdas, its CI roles) may ever do: use the project's own data and services."""
    keep = {"DynamoDB", "S3", "Lambda", "SQS", "SNS", "Alarms", "Logs", "Parameters"}
    return [st for st in resource_statements() if st["Sid"] in keep]

# CloudFormation's execution role for this project: may build and change the project's resources, nothing else.
# Split in two managed policies (6,144-character limit each); cdk bootstrap takes a list.
_all = resource_statements() + [
    {"Sid": "BootstrapVersion", "Effect": "Allow", "Action": ["ssm:GetParameter", "ssm:GetParameters"], "Resource": f"arn:aws:ssm:{region}:{account}:parameter/cdk-bootstrap/{qualifier}/version"},
]
_infra_sids = {"EC2Read", "EC2CreateTagged", "EC2RunInstancesSupporting", "EC2TagOnCreate", "EC2ChangeOwn", "EC2AssociateToOwnInstance", "IAMOwnRoles", "IAMBoundedWrites", "IAMPassOwnRoles", "IAMInstanceProfiles", "IAMReadOIDC", "NoEscapeFromBoundary"}
execution_a = {"Version": "2012-10-17", "Statement": [st for st in _all if st["Sid"] not in _infra_sids]}
execution_b = {"Version": "2012-10-17", "Statement": [st for st in _all if st["Sid"] in _infra_sids]}

# The permissions boundary on every role the project's stacks create. It grants no IAM or EC2 management, so a
# bounded role cannot make a role without the boundary or reach another project.
boundary = {"Version": "2012-10-17", "Statement": data_statements() + [
    {"Sid": "RuntimeAgents", "Effect": "Allow", "Action": ["ssm:UpdateInstanceInformation", "ssm:ListInstanceAssociations", "ssm:DescribeInstanceProperties", "ssm:DescribeDocumentParameters", "ssm:GetDocument", "ssm:DescribeAssociation", "ssm:GetDeployablePatchSnapshotForInstance", "ssm:GetManifest", "ssm:ListAssociations", "ssm:PutInventory", "ssm:PutComplianceItems", "ssm:PutConfigurePackageResult", "ssm:UpdateAssociationStatus", "ssm:UpdateInstanceAssociationStatus", "ssmmessages:*", "ec2messages:*", "cloudwatch:PutMetricData", "logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams", "sts:GetCallerIdentity", "ec2:DescribeInstances", "ec2:DescribeTags", "ssm:GetCommandInvocation"], "Resource": "*"},
    {"Sid": "DecryptViaSSM", "Effect": "Allow", "Action": "kms:Decrypt", "Resource": "*", "Condition": {"StringEquals": {"kms:ViaService": f"ssm.{region}.amazonaws.com"}}},
    {"Sid": "SendMail", "Effect": "Allow", "Action": ["ses:SendEmail", "ses:SendRawEmail"], "Resource": "*", "Condition": {"StringLike": {"ses:FromAddress": [f"*@{d}" for d in ses]}}},
    {"Sid": "DeployThroughBootstrap", "Effect": "Allow", "Action": "sts:AssumeRole", "Resource": f"arn:aws:iam::{account}:role/cdk-{qualifier}-*"},
    {"Sid": "RunOnOwnServers", "Effect": "Allow", "Action": "ssm:SendCommand", "Resource": "*", "Condition": {"StringEqualsIfExists": {"aws:ResourceTag/Project": P}}},
]}
print(json.dumps({"execution_a": execution_a, "execution_b": execution_b, "boundary": boundary}, separators=(",", ":")))
