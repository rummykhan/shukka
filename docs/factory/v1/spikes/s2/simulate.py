"""Spike S2: run the IAM policy simulator over the draft policies. Needs AWS credentials (read-only API)."""
import json, subprocess, sys
d = json.load(open(sys.argv[1]))
A = "818221194501"; R = "us-east-1"
BOUNDARY = f"arn:aws:iam::{A}:policy/trendigle-shukka-boundary"
def sim(policies, action, resource, ctx=None, boundary=None):
    cmd = ["aws", "iam", "simulate-custom-policy", "--policy-input-list", *[json.dumps(p) for p in policies],
           "--action-names", action, "--resource-arns", resource, "--output", "json"]
    if boundary: cmd += ["--permissions-boundary-policy-input-list", json.dumps(boundary)]
    if ctx:
        cmd += ["--context-entries", json.dumps([{"ContextKeyName": k, "ContextKeyValues": [v], "ContextKeyType": "string"} for k, v in ctx.items()])]
    out = json.loads(subprocess.run(cmd, capture_output=True, text=True, check=True).stdout)
    return out["EvaluationResults"][0]["EvalDecision"]
EX = [d["execution_a"], d["execution_b"]]
T = {"aws:ResourceTag/Project": "trendigle"}; O = {"aws:ResourceTag/Project": "orbitary"}
cases = [
 # (who, expect, action, resource, context)
 ("exec", "allowed", "dynamodb:CreateTable", f"arn:aws:dynamodb:{R}:{A}:table/trendigle_prod_login_attempts", None),
 ("exec", "allowed", "dynamodb:UpdateTimeToLive", f"arn:aws:dynamodb:{R}:{A}:table/trendigle_prod_login_attempts", None),
 ("exec", "allowed", "dynamodb:DeleteTable", f"arn:aws:dynamodb:{R}:{A}:table/trendigle-prod", None),
 ("exec", "allowed", "s3:PutBucketPolicy", "arn:aws:s3:::trendigle-prod-deploy-818221194501", None),
 ("exec", "allowed", "s3:PutLifecycleConfiguration", "arn:aws:s3:::trendigle-prod-media-818221194501", None),
 ("exec", "allowed", "iam:CreateRole", f"arn:aws:iam::{A}:role/Trendigle-prod-Instance-Role1ABCC5F0-5uGLbHErVSKT", {"iam:PermissionsBoundary": BOUNDARY}),
 ("exec", "allowed", "iam:PutRolePolicy", f"arn:aws:iam::{A}:role/Trendigle-prod-Instance-Role1ABCC5F0-5uGLbHErVSKT", {"iam:PermissionsBoundary": BOUNDARY}),
 ("exec", "allowed", "iam:PutRolePermissionsBoundary", f"arn:aws:iam::{A}:role/trendigle-prod-github-deploy", {"iam:PermissionsBoundary": BOUNDARY}),
 ("exec", "allowed", "iam:PassRole", f"arn:aws:iam::{A}:role/Trendigle-prod-Instance-Role1ABCC5F0-5uGLbHErVSKT", {"iam:PassedToService": "ec2.amazonaws.com"}),
 ("exec", "allowed", "iam:AddRoleToInstanceProfile", f"arn:aws:iam::{A}:instance-profile/Trendigle-prod-Instance-BoxInstanceProfile638444A1-TnKxws6n6v13", None),
 ("exec", "allowed", "ec2:ModifyInstanceAttribute", f"arn:aws:ec2:{R}:{A}:instance/i-07c0a9b38ff703056", T),
 ("exec", "allowed", "ec2:RunInstances", f"arn:aws:ec2:{R}:{A}:instance/*", {"aws:RequestTag/Project": "trendigle"}),
 ("exec", "allowed", "ec2:AuthorizeSecurityGroupIngress", f"arn:aws:ec2:{R}:{A}:security-group/sg-0abbdc99f01a29c9e", T),
 ("exec", "allowed", "route53:ChangeResourceRecordSets", "arn:aws:route53:::hostedzone/Z0369023VBLJHX9H3LHA", None),
 ("exec", "allowed", "lambda:CreateFunction", f"arn:aws:lambda:{R}:{A}:function:Trendigle-prod-Notify-Worker", None),
 ("exec", "allowed", "sqs:CreateQueue", f"arn:aws:sqs:{R}:{A}:trendigle-prod-events", None),
 ("exec", "allowed", "ssm:GetParameter", f"arn:aws:ssm:{R}:{A}:parameter/cdk-bootstrap/trendigle/version", None),
 ("exec", "implicitDeny", "dynamodb:DeleteTable", f"arn:aws:dynamodb:{R}:{A}:table/orbitary-prod-entities", None),
 ("exec", "implicitDeny", "s3:DeleteBucket", "arn:aws:s3:::orbitary-prod-media-818221194501", None),
 ("exec", "implicitDeny", "iam:UpdateAssumeRolePolicy", f"arn:aws:iam::{A}:role/Orbitary-prod-Instance-OrbitaryRole3A86A241-ivuB5uMdphsm", None),
 ("exec", "implicitDeny", "iam:CreateRole", f"arn:aws:iam::{A}:role/trendigle-escape", None),
 ("exec", "implicitDeny", "iam:CreateRole", f"arn:aws:iam::{A}:role/trendigle-escape", {"iam:PermissionsBoundary": f"arn:aws:iam::{A}:policy/other"}),
 ("exec", "explicitDeny", "iam:DeleteRolePermissionsBoundary", f"arn:aws:iam::{A}:role/Trendigle-prod-Instance-Role1ABCC5F0-5uGLbHErVSKT", None),
 ("exec", "explicitDeny", "iam:CreatePolicyVersion", BOUNDARY, None),
 ("exec", "implicitDeny", "iam:PassRole", f"arn:aws:iam::{A}:role/Orbitary-prod-Instance-OrbitaryRole3A86A241-ivuB5uMdphsm", {"iam:PassedToService": "ec2.amazonaws.com"}),
 ("exec", "implicitDeny", "ec2:TerminateInstances", f"arn:aws:ec2:{R}:{A}:instance/i-0orbitary", O),
 ("exec", "implicitDeny", "ec2:RunInstances", f"arn:aws:ec2:{R}:{A}:instance/*", {"aws:RequestTag/Project": "orbitary"}),
 ("exec", "implicitDeny", "route53:ChangeResourceRecordSets", "arn:aws:route53:::hostedzone/ZOTHERZONE", None),
 ("exec", "implicitDeny", "iam:CreateOpenIDConnectProvider", f"arn:aws:iam::{A}:oidc-provider/token.actions.githubusercontent.com", None),
 ("exec", "implicitDeny", "iam:AttachRolePolicy", f"arn:aws:iam::{A}:role/trendigle-x", None),
 ("exec", "implicitDeny", "cloudformation:DeleteStack", f"arn:aws:cloudformation:{R}:{A}:stack/Orbitary-prod-Data/x", None),
]
# What today's Trendigle roles do, which the boundary must still allow (identity policy = allow-all, so only the boundary decides).
ALLOW_ALL = {"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Action": "*", "Resource": "*"}]}
bcases = [
 ("bounded", "allowed", "dynamodb:PutItem", f"arn:aws:dynamodb:{R}:{A}:table/trendigle_prod_posts", None),
 ("bounded", "allowed", "dynamodb:Query", f"arn:aws:dynamodb:{R}:{A}:table/trendigle_prod_posts/index/by_time", None),
 ("bounded", "allowed", "dynamodb:GetItem", f"arn:aws:dynamodb:{R}:{A}:table/trendigle-prod", None),
 ("bounded", "allowed", "s3:GetObject", "arn:aws:s3:::trendigle-prod-media-818221194501/u/x.png", None),
 ("bounded", "allowed", "s3:GetObject", "arn:aws:s3:::trendigle-prod-deploy-818221194501/app/bundle.tgz", None),
 ("bounded", "allowed", "s3:PutObject", "arn:aws:s3:::trendigle-prod-deploy-818221194501/trendigle/app/abc.tgz", None),
 ("bounded", "allowed", "ssm:GetParametersByPath", f"arn:aws:ssm:{R}:{A}:parameter/trendigle/prod", None),
 ("bounded", "allowed", "ssm:GetParameter", f"arn:aws:ssm:{R}:{A}:parameter/trendigle/prod/SESSION_SECRET", None),
 ("bounded", "allowed", "kms:Decrypt", f"arn:aws:kms:{R}:{A}:key/abc", {"kms:ViaService": f"ssm.{R}.amazonaws.com"}),
 ("bounded", "allowed", "ssmmessages:CreateControlChannel", "*", None),
 ("bounded", "allowed", "ssm:UpdateInstanceInformation", f"arn:aws:ec2:{R}:{A}:instance/i-07c0a9b38ff703056", None),
 ("bounded", "allowed", "ec2messages:GetMessages", "*", None),
 ("bounded", "allowed", "ssm:SendCommand", f"arn:aws:ssm:{R}::document/AWS-RunShellScript", None),
 ("bounded", "allowed", "ssm:SendCommand", f"arn:aws:ec2:{R}:{A}:instance/i-07c0a9b38ff703056", T),
 ("bounded", "allowed", "sts:AssumeRole", f"arn:aws:iam::{A}:role/cdk-trendigle-deploy-role-{A}-{R}", None),
 ("bounded", "allowed", "ses:SendRawEmail", f"arn:aws:ses:{R}:{A}:identity/mail.trendigle.com", {"ses:FromAddress": "no-reply@mail.trendigle.com"}),
 ("bounded", "allowed", "sqs:SendMessage", f"arn:aws:sqs:{R}:{A}:trendigle-prod-events", None),
 ("bounded", "implicitDeny", "dynamodb:Scan", f"arn:aws:dynamodb:{R}:{A}:table/orbitary-prod-entities", None),
 ("bounded", "implicitDeny", "s3:GetObject", "arn:aws:s3:::orbitary-prod-media-818221194501/x", None),
 ("bounded", "implicitDeny", "ssm:GetParameter", f"arn:aws:ssm:{R}:{A}:parameter/orbitary/prod/SECRET", None),
 ("bounded", "implicitDeny", "ssm:SendCommand", f"arn:aws:ec2:{R}:{A}:instance/i-0orbitary", O),
 ("bounded", "implicitDeny", "iam:CreateRole", f"arn:aws:iam::{A}:role/trendigle-x", None),
 ("bounded", "implicitDeny", "iam:PutRolePolicy", f"arn:aws:iam::{A}:role/Trendigle-prod-Instance-Role1ABCC5F0-5uGLbHErVSKT", None),
 ("bounded", "implicitDeny", "ec2:RunInstances", f"arn:aws:ec2:{R}:{A}:instance/*", None),
 ("bounded", "implicitDeny", "sts:AssumeRole", f"arn:aws:iam::{A}:role/cdk-hnb659fds-deploy-role-{A}-{R}", None),
 ("bounded", "implicitDeny", "iam:CreateOpenIDConnectProvider", f"arn:aws:iam::{A}:oidc-provider/token.actions.githubusercontent.com", None),
 ("bounded", "implicitDeny", "ses:SendRawEmail", f"arn:aws:ses:{R}:{A}:identity/mail.trendigle.com", {"ses:FromAddress": "x@evil.example"}),
]
fails = 0
for who, want, act, res, ctx in cases + bcases:
    got = sim(EX, act, res, ctx) if who == "exec" else sim([ALLOW_ALL], act, res, ctx, boundary=d["boundary"])
    ok = got == want
    fails += not ok
    print(f"{'ok  ' if ok else 'FAIL'} {who:7} {act:38} {res.split(':')[-1][:60]:60} {got}{'' if ok else ' (want '+want+')'}")
print(f"\n{len(cases)+len(bcases)} cases, {fails} failed")
sys.exit(1 if fails else 0)
