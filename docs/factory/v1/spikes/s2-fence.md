# Spike S2: a limited execution role and permissions boundary per project (2026-11-22)

Files: `s2/policy.py` (generates the documents for one project), `s2/simulate.py` (58 cases through the IAM policy simulator), `s2/trendigle.json` (Trendigle's documents). No resources were created; the simulator is a read-only API.

Result: 58 of 58 cases as intended, after one fix (the boundary allowed any SES action on Trendigle's identities, so any From address; SES is now only `SendEmail`/`SendRawEmail` with a From address on the project's domains).

What the cases cover:
- **Execution policy, allowed:** creating, changing and deleting every kind of resource in Trendigle's four stacks today, plus the queue, Lambda and SES identity the notifications epic will add. Covers tables (including the legacy `trendigle-prod`), buckets, the role (only with the boundary), instance profile, pass-role to EC2, instance changes (by tag), security groups, the hosted zone by id, and the bootstrap version parameter.
- **Execution policy, refused:**
  - Orbitary's tables, bucket, role, instance and stack;
  - creating a role without the boundary, or with a different boundary;
  - removing a boundary, or editing the boundary policy;
  - another hosted zone;
  - the account's GitHub OIDC provider.
- **Boundary, allowed:** everything Trendigle's server role and CI roles do today (data access, its parameters, decrypting through SSM, the SSM agent, uploading bundles, sending commands to its own server, assuming its own bootstrap roles), and sending mail from its own domain.
- **Boundary, refused:** Orbitary's data, parameters and server; any IAM write; launching instances; the default bootstrap's roles; mail from another domain.

Findings that change the design or the plan:
1. **Size limit.** A managed policy holds at most 6,144 characters. The execution policy is split in two (3.2k and 4.4k, both handed to `cdk bootstrap`). The boundary grants no IAM or EC2 management, so it fits in one (3.7k). That is also what stops a bounded role from making an unbounded one.
2. **Fence by name prefix.** Resources must be named `<project>*` or `<Project>*`; CDK's generated names start with the stack name, which already does. Rule: **no project name may be a prefix of another** (`trendigle` vs `trendiglepro`). The config validator should refuse it against a list of known projects in the account (account stack output).
3. **The GitHub OIDC provider belongs to the account, not a project.** Today it sits in Trendigle's Ci stack as a CDK custom resource whose Lambda needs account-wide rights on OIDC providers. Under the boundary that Lambda can do nothing, and Orbitary needs the same provider.
   - Plan: a small account stack, `Shukka-Account`, deployed with admin credentials by `shukka bootstrap --account`, owns the provider. Projects import it by ARN.
   - Migration for Trendigle, while the old admin execution role still applies:
     1. Mark the custom resource `RETAIN` and deploy.
     2. Remove it from the Ci stack. The guard shows the removal; allow it by hand.
     3. Import the provider into `Shukka-Account`.
4. **Loophole to close in the construct.** `ssm:SendCommand` uses `StringEqualsIfExists` on the instance tag, which lets through an instance with no `Project` tag. Split it: the document by ARN, instances with `StringEquals`.
5. **What the simulator cannot prove.** It checks the policies against the requests I listed, not the exact calls CloudFormation makes. EC2 tag-on-create and the instance profile dance are the usual surprises. So acceptance for R3 uses a real throwaway project, `shukkatest`:
   - a t4g.nano instance with an elastic IP, security group, launch template, role and profile, plus a table, a bucket, and a record in its own throwaway hosted zone (free if deleted within 12 hours);
   - created, changed and deleted entirely through its own limited role;
   - and its role must be refused on Trendigle.

   Cost: a few cents.
