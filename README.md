# shukka

出荷 (*shukka*): shipping out. A reusable, cheap and careful deployment pipeline for AWS CDK projects on GitHub Actions.

**Status:** v1 is built and tested in this repository (unit tests, policy simulator, the release script in Docker), but it has **not yet been proven end to end on real AWS**. That proof is the acceptance run against a test project (`test/acceptance/`). Until it passes there is no `v1` tag, only release candidates (`v1.0.0-rc.N`). Do not point a production project at shukka before then.

A new project follows [docs/consumer-checklist.md](docs/consumer-checklist.md): every step, with its command. This README explains why each step is there.

## What shukka does

Your project keeps its CDK app and its build. shukka gives it:

- **One reusable workflow.** Your whole CI file is about ten lines that call `rummykhan/shukka/.github/workflows/pipeline.yml@v1`. Settings live in one file, `shukka.json`, in your project root.
- **Pull requests:** your checks run, and the infrastructure diff is posted as one comment on the pull request (updated in place). Pull request code never gets AWS credentials.
- **Merges to `main`:** checks and builds, then `cdk diff`, a guard that stops the run if anything would be deleted or replaced, `cdk deploy`, then each app is uploaded and released on your EC2 servers through SSM, with a health check and automatic rollback, then your smoke test.
- **Only what changed deploys.** shukka reads the last deployed commit from AWS (a `shukka:revision` tag on each stack, a `REVISION` file on each server) and skips parts whose files did not change. A docs-only merge deploys nothing.
- **A fence between projects.** Each project gets its own CDK bootstrap whose CloudFormation execution role can touch only that project's resources, and can create IAM roles only with the project's permissions boundary on them.
- **An emergency deploy from a laptop** (`shukka deploy`) for when GitHub is down: the same guard, release and health check.

```
your repo                                   rummykhan/shukka (public, tagged)
.github/workflows/ci.yml ──uses──►  pipeline.yml   plan → checks, build → infra → app → smoke
shukka.json  ◄── read by the workflows and the CLI
infra/ (your CDK app)  ── imports ──►  lib/   ShukkaAccess, shukkaSynthesizer, applyBoundary
                                     infra.yml  (nested) synth, diff, guard, cdk deploy   ← infra role
                                     ec2.yml    (nested) upload, release through SSM      ← app role
                                     box/shukka-release.sh  runs on your server as root
                                     bin/shukka  CLI: bootstrap, diff, deploy
```

What it does not do: ECS or Lambda-only app deploys, several environments per project (there is one `prod`), Docker image assets, or anything that needs paid GitHub or AWS CI services.

## Security model

shukka holds no secrets and stores no AWS keys. GitHub Actions asks AWS for short-lived credentials through OpenID Connect (OIDC). This section says who can reach what, and, as plainly, what is not stopped.

### Who can reach which role

Every role trusts GitHub's OIDC provider with three conditions, all required: the audience is `sts.amazonaws.com`; the subject is your repository on `main` (or, for the diff role, a pull request in your repository); and the `job_workflow_ref` claim names **shukka's own nested workflow file** at a `v1` tag. The `job_workflow_ref` claim names the innermost reusable workflow running the job, so a job in your own workflow, or in `pipeline.yml`, cannot ask for these roles. Only `infra.yml` and `ec2.yml` request a token, and they run only shukka's code.

| Role | Who can assume it | What it can do |
|---|---|---|
| `<project>-shukka-infra` | `infra.yml` at a shukka `v1` tag, run for your repo on `main` | Assume your project's bootstrap deploy and file-publishing roles. Nothing else. |
| `<project>-shukka-app` | `ec2.yml` at a shukka `v1` tag, run for your repo on `main` | Upload to `s3://<bucket>/<project>/*`; run `AWS-RunShellScript` through SSM **as root** on instances tagged `Project=<project>`; read `/<project>/prod/*` parameters; read SSM command results and describe instances (these reads cannot be narrowed to one project). |
| `<project>-shukka-diff` | `infra.yml` at a shukka `v1` tag, run for a pull request in your repo | Read the templates and status of your project's stacks, and your bootstrap's version parameter. It cannot change anything. |
| `cdk-<qualifier>-deploy-role-…` (your bootstrap) | Your infra role, and the emergency principals named at bootstrap (by default whoever ran it) | CloudFormation on stacks named `<project>-*` or `<Project>-*` only, and only with your project's own execution role. |
| `cdk-<qualifier>-file-publishing-role-…` | The same | Write to your project's CDK asset bucket only. |
| `cdk-<qualifier>-cfn-exec-role-…` | CloudFormation, passed by the deploy role | The fence: your project's three execution policies, nothing else. |
| Roles your stacks create (servers, Lambdas) | Whatever you say | Limited by your project's permissions boundary: your project's own data and services; no IAM and no EC2 management. |

There is no lookup role in a shukka bootstrap (CDK's stock one can read the whole account), so `cdk.context.json` must be committed and the pipeline does no live context lookups.

### What the fence stops

The execution role and the boundary allow actions only on resources named with your project's prefix (`<project>*`, or `<Project>-*` as CDK names them), on EC2 resources tagged `Project=<project>`, on the one Route 53 hosted zone and the SES mail domains named at bootstrap. So, with your pipeline's credentials:

- another project's stacks, tables, buckets, queues, functions, parameters, servers and hosted zones are refused;
- a role cannot be created without your boundary, and the boundary cannot be removed or edited;
- your bootstrap stack, your boundary stack and the account stack are out of reach (their names do not start with your project's name);
- the account's GitHub OIDC provider cannot be changed.

The fence covers these services: DynamoDB, S3, Lambda, SQS, SNS, CloudWatch alarms and Logs, SSM parameters, Route 53 (one zone), SES sending, EC2 (instances, security groups, launch templates, elastic IPs, volumes, all tagged), and IAM roles and instance profiles (bounded). A stack that uses any other service (CloudFront, ACM, API Gateway, RDS, new VPCs, ECR…) is refused at deploy time. Supporting it means a change to shukka's fence.

Inside the pipeline:

- Pull request code, your checks, your builds, your CDK app's synth and your smoke test run in jobs with no `id-token` permission, so they cannot get AWS credentials at all. A compromised build dependency reaches nothing in AWS.
- The credentialed jobs install nothing of yours and run none of your code: they read the synthesized cloud assembly with shukka's own pinned `cdk` CLI. An assembly whose assets run a command, build a Docker image or point outside it is refused before any role is assumed.
- The configure hook that runs as root on your server is read from your git checkout, never from the build artifact, so a dependency cannot plant root code in the bundle.
- Pull requests from forks and Dependabot get no OIDC token from GitHub; their diff job is skipped with a notice.

### What it does not stop

Read this part before you adopt shukka.

- **Anyone who can push to your `main` can change your project's resources**, delete its data, and run code as root on its servers (through the configure hook and the app itself). Merge to `main` is the production approval. The destructive-change guard stops accidents, not someone who intends harm: they can tick `allow_replacement`, or change your app's code. Protect `main` (branch protection, required review) if your plan allows it, and limit who can push.
- **Anyone who can push to `main` can change who your CI roles trust.** The CI stack (`ShukkaAccess`) is deployed by the pipeline like any other stack, and its roles are inside your fence, so a merge can rewrite their trust policies to admit an outside principal (another AWS account, another repository). That principal then holds your pipeline's access: still fenced to your project, but no longer tied to shukka's workflows on your `main`. v1 does not stop such a change; review every diff to `<Project>-Ci`.
- **What the pipeline shows is visible to anyone who can read your repository.** The run summaries and the pull-request comment hold the full `cdk diff` (template contents included); the release output holds everything the release script and your configure hook print. shukka never prints your settings files, but it cannot stop your hook, build or smoke commands from printing a secret. In a public repository that means the whole world: keep secrets out of templates, user data, State Manager association parameters and configure-hook output.
- **`shukka.json` names your AWS account id and project name.** In a public repository, anyone can read which account you deploy to and what your project's resources are called. That is not a credential, but it is a map.
- **User data and launch templates must hold no secrets.** EC2's describe calls (including `DescribeLaunchTemplateVersions`, which returns user data) cannot be limited to one project, so every project's pipeline can read every instance's description in the account. Keep secrets in SSM Parameter Store (`/<project>/prod/...`) and read them on the server.
- **Build-time values are not secret.** `buildEnv` values become GitHub repository variables (plain text). `shukka bootstrap` refuses a `SecureString`. Secrets belong on the server, read at run time.
- **shukka must never be renamed or moved**, and neither may the `rummykhan` account. The `job_workflow_ref` claim carries names, not ids: if `rummykhan/shukka` stopped existing at that name, whoever created a repository there could publish an `infra.yml` your roles trust. (Your side of the subject can use immutable ids; see the next point.)
- **Use the immutable subject for your repository** where GitHub gives you one: `owner@<owner-id>/repo@<repo-id>` instead of `owner/repo`. With names only, a renamed or deleted repository's name could be taken by someone else whose `main` your roles would then trust. Pass exactly the form your repository's OIDC tokens carry; a mismatch is simply refused.
- **You trust shukka's tags with your AWS account.** Whoever can push tags to `rummykhan/shukka` decides what the pipeline runs. Pinning `@v1` takes every new v1 release automatically; pin `@v1.x.y` to choose when (see [Versioning](#versioning-and-pins)).
- **The fence is a name prefix.** A resource someone made by hand whose name starts with your project's name is inside your fence. Project names must not be prefixes of each other (`acme` and `acmepro`); `shukka bootstrap` refuses such a name, but only against projects it knows about.
- **The account is shared.** Read-only calls that AWS cannot scope to a resource (describing instances, reading SSM command results by id) work across projects.
- **Bootstrap and the first deploy of the CI stack run with admin credentials.** Run `shukka bootstrap` from outside your project directory (below), and deploy the CI stack only from a checkout you trust.
- **The emergency deploy runs your build on your laptop.** shukka removes AWS variables and points the AWS config files at empty files for your code, but code that reads `~/.aws` by path is not stopped. Run it as a non-admin emergency principal where you can.

## Adopting shukka

You need: an AWS account with admin credentials for the one-time setup; a GitHub repository; Node 22, `git`, the AWS CLI v2 and `gh` (signed in, with admin on the repository) on the machine you set up from; a CDK app in TypeScript or JavaScript; and one Route 53 hosted zone the project may change.

The example project below is `acme`, repository `acme-org/acme`, account `123456789012`, region `us-east-1`. Replace them with yours.

### 1. Account bootstrap (once per AWS account)

Deploys the `Shukka-Account` stack, which owns the account's GitHub OIDC provider and lists the projects in the account. With the account admin's credentials:

```bash
cd ~
npx github:rummykhan/shukka#v1 bootstrap --account --region us-east-1 --profile admin
```

If the account already has a GitHub OIDC provider, shukka refuses and tells you its ARN; import it instead:

```bash
npx github:rummykhan/shukka#v1 bootstrap --account --region us-east-1 --profile admin \
  --oidc-provider-arn arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com
```

`bootstrap` and `deploy` take `--dry-run`, which runs the lookups and prints what would change without changing anything. `diff` has no `--dry-run`: it changes nothing anyway.

### 2. Write `shukka.json`

In your project root. The schema (`schema/shukka.schema.json`) documents every field; editors pick it up from `$schema`.

```json
{
  "$schema": "https://raw.githubusercontent.com/rummykhan/shukka/v1/schema/shukka.schema.json",
  "project": "acme",
  "qualifier": "acme",
  "aws": { "account": "123456789012", "region": "us-east-1" },
  "node": "22",
  "checks": [
    { "name": "web", "dir": "web", "run": ["npm ci", "npm run lint", "npm test"], "services": ["dynamodb-local"] }
  ],
  "infra": { "dir": "infra", "paths": ["infra/**"] },
  "apps": [
    {
      "name": "web",
      "paths": ["web/**"],
      "build": { "dir": "web", "run": ["npm ci", "npm run build"], "bundle": "scripts/bundle.sh",
                 "env": { "APP_URL": "https://acme.example" }, "buildEnv": ["CONTACT_EMAIL"] },
      "server": { "configure": "infra/box/configure-web.sh", "units": ["acme-web"], "health": "http://127.0.0.1:3000/health" }
    }
  ],
  "smoke": { "run": "bash infra/smoke.sh" },
  "fence": { "hostedZoneIds": ["Z0123456789ABCDEFGHIJ"], "mailDomains": ["acme.example"] }
}
```

- `project`: lowercase, 2 to 21 characters, and **not a prefix of another project's name** in the account (nor prefixed by one). It prefixes every resource, stack and role. Reserved: `shukka`, `cdk`, `cdktoolkit` and `aws`, any prefix of them (`aw`, `shuk`), and any `<reserved>-…` name (`aws-tools`).
- `qualifier`: your CDK bootstrap qualifier: starts with a letter, 2 to 10 lowercase letters and digits. Usually the project name.
- `checks`: commands run on pull requests and merges, with no AWS access. The only service shukka can start is `dynamodb-local`.
- `infra.dir`: where your CDK app lives (`cdk.json`, `package-lock.json`); `infra.paths`: the files that count as an infrastructure change.
- `apps[].build.bundle`: a script in the build dir that prints the path of the directory to ship. `scripts/bundle.sh` is provided by shukka for Next.js `output: 'standalone'` (it adds `.next/static` and `public` and deletes every `.env*`).
- `apps[].build.env`: non-secret values written in the file. `buildEnv`: names of non-secret values read from GitHub repository variables (step 6 copies them there).
- `apps[].server.health`: a URL on the server itself (`127.0.0.1` or `localhost`).
- `aws.deployBucket`: optional; the bucket for app bundles. Default `<project>-deploy-<account>`. If you set it, it must start with the project name, or your stacks cannot create it through the fence.
- `alwaysDeploy`: deploy everything on every merge. Default `false`.
- `fence`: the hosted zone (exactly one, by id) and the SES domains your stacks may change. Read by `shukka bootstrap`.

At most 20 apps.

### 3. Your CDK app

Install shukka's constructs from the same tag as a git dependency, in your infra directory:

```bash
cd infra
npm install --save github:rummykhan/shukka#v1.2.3 aws-cdk-lib constructs tsx
npm install --save-dev --save-exact aws-cdk@2.1148.0
```

Use an exact tag for the constructs (see [Versioning](#versioning-and-pins)). `aws-cdk` at shukka's pinned version (2.1148.0 in this release) keeps your local `cdk` reading the same cloud assembly as the pipeline's.

shukka's constructs are TypeScript source, so run your CDK app with `tsx` (`cdk.json`: `"app": "npx tsx bin/app.ts"`; it works for a `.mjs` app too). Import them from `shukka/lib/index.ts`. Commit `package-lock.json`: the pipeline runs `npm ci`.

```ts
// infra/bin/app.ts
import { App, Stack, Tags } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { ShukkaAccess, applyBoundary, shukkaSynthesizer } from 'shukka/lib/index.ts';

const app = new App();
const env = { account: '123456789012', region: 'us-east-1' };
const synthesizer = shukkaSynthesizer('acme');           // your qualifier

// The CI stack: the three roles the pipeline assumes. Deployed by hand once (step 5).
const ci = new Stack(app, 'Acme-Ci', { env, synthesizer });
new ShukkaAccess(ci, 'Access', {
  project: 'acme',
  githubRepo: 'acme-org@1234567/acme@890123456',          // the subject form your tokens carry
  deployBucket: s3.Bucket.fromBucketName(ci, 'DeployBucket', 'acme-deploy-123456789012'),
});

// Your own stacks: every one with { env, synthesizer }, named Acme-... or acme-...
// new BoxStack(app, 'Acme-Box', { env, synthesizer });

Tags.of(app).add('Project', 'acme');    // EC2 resources must carry it
applyBoundary(app, 'acme');             // every role gets the project's boundary, CDK's own roles too
```

What each piece is for:

- **`shukkaSynthesizer(qualifier)`** makes every stack deploy through your project's own bootstrap (the fenced execution role) instead of the account's default one.
- **`applyBoundary(app, project)`** puts your permissions boundary on every IAM role in the app, including the ones CDK makes for custom resources. Without it, the execution role refuses to create the role.
- **`ShukkaAccess`** creates `acme-shukka-infra`, `acme-shukka-app` and `acme-shukka-diff`. Options: `oidcProviderArn` (default: the account's GitHub provider ARN), `shukkaVersions` (the release line the roles trust, default `v1`; `v1.2` narrows it), `instanceTag` (default `Project=<project>`), `ssmPath` (default `/<project>/prod`), `qualifier` (default the project name), and `allowBranch` (release-candidate testing only; never in production).
- To get your repository's immutable subject: `gh api repos/acme-org/acme --jq '"\(.owner.login)@\(.owner.id)/\(.name)@\(.id)"'`.

Rules your stacks must follow:

- **Names.** Stack names start with `<project>-` or `<Project>-`. Resources you name yourself start with the project name (`acme-items`, `acme-deploy-123456789012`). CDK's generated names start with the stack name, which already does.
- **No live lookups. Commit `cdk.context.json`.** The pipeline synthesizes with no AWS credentials and the bootstrap has no lookup role, so `Vpc.fromLookup`, `HostedZone.fromLookup` and `MachineImage.lookup` must already be answered in `cdk.context.json`. Simplest is to avoid lookups: pass ids (`Vpc.fromVpcAttributes`, `HostedZone.fromHostedZoneAttributes`, `MachineImage.genericLinux`).
- **The deploy bucket** (`<project>-deploy-<account>`, or `aws.deployBucket`) is yours to create in one of your stacks: block public access, enforce SSL, and add a lifecycle rule expiring `<project>/` objects after 30 days (servers keep their own copies).
- **The server** needs: the tag `Project=<project>`; an instance role with `AmazonSSMManagedInstanceCore` and read access to `s3://<bucket>/<project>/*`; and `bash`, the AWS CLI, `curl`, `flock` and systemd. Amazon Linux 2023 has all of them. No inbound port is needed for deploys.
- **No Docker image assets.** File assets (Lambda code, zipped directories) are fine.

### 4. Project bootstrap (once per project)

Deploys the project's fence (stack `Shukka-Boundary-<project>`: the boundary and three execution policies), the project's own CDK bootstrap (stack `CDKToolkit-<qualifier>`), copies each `buildEnv` value from Parameter Store to a GitHub repository variable, and adds the project to `Shukka-Account`'s list.

It uses the **account admin's credentials**. Run it **from outside the project directory**, pointing at the project with `--config` and `--repo`: `npx` run inside a project reads that project's npm configuration, and the project's files must not get a chance to run next to admin credentials.

```bash
cd ~
npx github:rummykhan/shukka#v1 bootstrap acme \
  --config ~/src/acme/shukka.json --repo acme-org/acme --profile admin
```

First put each `buildEnv` value in Parameter Store as a plain `String` (bootstrap refuses a `SecureString`):

```bash
aws ssm put-parameter --name /acme/prod/CONTACT_EMAIL --type String --value hello@acme.example --profile admin
```

Before changing anything, bootstrap refuses: a project name that prefixes another project in the account (or is prefixed by one); a hosted zone or mail domain already in another project's fence; a qualifier already used by something other than shukka for this project (or CDK's default `hnb659fds`); private CloudFormation extensions in the account (they run with their own roles; `--allow-private-types` goes ahead after listing them); and roles named like the project that lack its boundary.

Useful flags: `--hosted-zone-id` and `--mail-domain` override `fence` in `shukka.json`; `--emergency-principal <role or user ARN>` (repeatable) names who may run `shukka deploy` from a laptop (default: whoever runs the bootstrap; the account root is refused, so run it as an IAM role or user); `--dry-run`. Running it again is safe and is how you change the fence or the emergency principals. **Re-running without `--emergency-principal` resets the emergency principals to whoever runs it**, so name every principal you want to keep each time.

### 5. Deploy the CI stack once, by hand

A pipeline cannot create the role it runs as, so `ShukkaAccess` is deployed once with admin credentials. It goes through your project's bootstrap like everything else (the admin is an emergency principal by default):

```bash
cd ~/src/acme/infra
npm ci
npx cdk deploy Acme-Ci --profile admin
```

This runs your CDK app with admin credentials: do it from a clean checkout you trust. After this, the pipeline deploys `Acme-Ci` like any other stack.

### 6. Repository variables

Each name in `buildEnv` must exist as a GitHub repository variable. `shukka bootstrap` copies them from `/<project>/prod/<NAME>`; to change one later, change the parameter and run bootstrap again, or set it directly:

```bash
gh variable set CONTACT_EMAIL --repo acme-org/acme --body hello@acme.example
gh variable list --repo acme-org/acme
```

A build fails if a `buildEnv` variable is missing. shukka needs no repository secrets.

### 7. The caller workflow

This is your whole CI file, `.github/workflows/ci.yml`. Remove any other workflow that deploys.

```yaml
name: CI
on:
  pull_request:
  push: { branches: [main] }
  workflow_dispatch:
    inputs:
      allow_replacement: { type: boolean, default: false }
      force: { type: boolean, default: false }
jobs:
  shukka:
    uses: rummykhan/shukka/.github/workflows/pipeline.yml@v1
    permissions: { contents: read, id-token: write, pull-requests: write }
    with:
      allow_replacement: ${{ inputs.allow_replacement || false }}
      force: ${{ inputs.force || false }}
```

Inputs: `config` (path of `shukka.json`, default `shukka.json`), `allow_replacement` (honoured only on a run started by hand on `main`), `force` (deploy every part whatever changed), and `shukka_ref` (only when `plan` says it cannot read the caller file). If your organisation restricts which actions may run, allow `rummykhan/shukka` and the actions its workflows pin (`actions/checkout`, `actions/setup-node`, `actions/upload-artifact`, `actions/download-artifact`, and `aws-actions/configure-aws-credentials`, which every credentialed job uses).

Push it to `main`. The first merge deploys everything: no stack carries a `shukka:revision` tag yet and no server has a `REVISION` file.

### 8. The configure hook

Each app names a hook in `server.configure`, a script in your repository. The contract:

- It is taken **from git** (the commit being released), uploaded to S3 and run from `/opt/<project>/<app>/hooks/<sha>.sh`. A file at that path inside the bundle is never run.
- It runs as root, as `hook.sh <release-dir>`, with `PROJECT`, `APP`, `SHA` and `REGION` in the environment.
- It writes settings files, users and systemd units, and units point at `/opt/<project>/<app>/current`.
- It **must be idempotent**: it runs on every release, and runs again for the older release on rollback.
- It **enables** its units (`systemctl enable`) and **never starts or restarts** them; the release script restarts them after switching `current`.
- `/opt/<project>` and `/opt/<project>/<app>` are root-owned and not writable by group or others (the release script takes them back if not). Put the app user's home and writable data somewhere else (for example `/var/lib/<project>`).
- If the hook fails, nothing is switched and the new release is deleted (exit 11).

A minimal hook:

```bash
#!/usr/bin/env bash
set -euo pipefail
: "${PROJECT:?}" "${APP:?}"
id -u "$PROJECT" >/dev/null 2>&1 || useradd --system --home-dir "/var/lib/$PROJECT" --create-home --shell /sbin/nologin "$PROJECT"
cat >"/etc/systemd/system/$PROJECT-$APP.service" <<UNIT
[Unit]
After=network-online.target
[Service]
User=$PROJECT
WorkingDirectory=/opt/$PROJECT/$APP/current
ExecStart=/usr/bin/node /opt/$PROJECT/$APP/current/server.js
Restart=on-failure
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable "$PROJECT-$APP"
```

### Moving an existing project onto shukka

If your stacks already exist under the account's default bootstrap:

- Move them to the new qualifier one at a time, low-risk stack first. Moving changes their asset bucket and execution role; `cdk diff` must show only metadata and asset changes, and the guard stops anything else.
- The fence must allow every existing resource, or an update can fail halfway. Make the first deploy through the new bootstrap a no-change deploy.
- Leave **no pending change sets** on project stacks: the deploy role may execute a change set an admin created earlier, with the admin's role. `aws cloudformation list-change-sets --stack-name <stack>`, then `delete-change-set`.
- Roles named like the project but without its boundary make bootstrap refuse. Add `applyBoundary` and deploy, or delete them.
- Keep the old roles and the default bootstrap until the project has deployed cleanly through shukka twice.

## When a merge would delete or replace something

Before deploying, the infra job writes the full `cdk diff` to the run summary (`### Infrastructure changes`) with the guard's verdict (`### Guard`). If anything would be deleted or replaced, or the diff is incomplete, the run stops: nothing is deployed, apps are not released, and the log names the resources:

```
guard: these changes delete or replace a resource:
...
guard: stopping. If this is intended, run the workflow by hand on main with allow_replacement ticked.
```

On a pull request, the diff comment says the merge will stop. A removed stack output is not destructive.

To go ahead on purpose, read the diff, then start the workflow by hand on `main` with `allow_replacement` ticked (Actions tab, "Run workflow"), or:

```bash
gh workflow run CI --repo acme-org/acme --ref main -f allow_replacement=true
```

`allow_replacement` is ignored on pushes and pull requests, so it cannot be switched on for every merge. Mark tables, buckets and zones `RemovalPolicy.RETAIN` so a replacement keeps the old data.

Other CloudFormation states that need an admin:

- **A stack whose first create failed** (`ROLLBACK_COMPLETE`) must be deleted by an admin before the pipeline can create it again. CDK deletes such a stack without passing a `RoleArn`, and the deploy role denies every `DeleteStack` without the project's execution role as `RoleArn`.

  ```bash
  aws cloudformation delete-stack --stack-name Acme-Box --profile admin
  ```

## Rollback on the server

`box/shukka-release.sh` runs on each server as root, sent by `ec2.yml` through SSM. For each app it keeps:

```
/opt/<project>/<app>/releases/<sha>/   unpacked bundle plus REVISION
/opt/<project>/<app>/current  -> the live release
/opt/<project>/<app>/previous -> the one before
/opt/<project>/<app>/hooks/<sha>.sh    the configure hook of each release (root, 0700)
```

A release downloads the bundle, unpacks it into a new directory, runs the configure hook, switches `current`, restarts the app's units, and polls the health URL every 2 seconds (default timeout 60) until it answers 2xx or 3xx with every unit `active`. If it is unhealthy, `current` goes back to the old release, its hook runs again, its units restart and it is health-checked. The last 5 releases are kept. Two releases of one app never interleave (a lock per app); different apps do not wait for each other, and releasing one leaves the others running.

The run's last line says what happened, for example `shukka: acme/web 1a2b3c4 -> 5d6e7f8 rolled-back`:

| Exit | Result | What it means |
|---|---|---|
| 0 | `live` | new release live and healthy |
| 10 | `download-failed` | download or unpack failed; nothing changed |
| 11 | `configure-failed` | the hook failed; nothing switched, new release deleted |
| 12 | `rolled-back` | unhealthy; the previous release is live and healthy. The run is red. |
| 13 | `rollback-unhealthy` | unhealthy, and the rollback too (or nothing to roll back to): **log in and fix it** |

To see what a server runs: `cat /opt/<project>/<app>/current/REVISION` (through an SSM session).

To go back to an older version on purpose, revert the commit on `main`; the revert is a new commit and deploys like any other. A run for an older commit than the one live (a slow run overtaken by a quick merge) is skipped with a notice, so the latest merge always ends up live.

## Emergency deploy (GitHub is down)

`shukka deploy` does what the pipeline does, in the same order, from your machine: checks, build and bundle each app, `cdk synth`, `cdk diff` and the guard, `cdk deploy` with the `shukka:revision` tag, then upload and release each app with the same health check and rollback, then smoke. Every part deploys, whatever changed.

Prepare it **before** you need it, because `npx github:...` cannot download shukka while GitHub is down. Keep a clone at your pinned tag:

```bash
git clone --branch v1 https://github.com/rummykhan/shukka ~/shukka && (cd ~/shukka && npm ci)
```

Then, from a clean checkout of your project at `origin/main`, as an emergency principal named at bootstrap:

```bash
cd ~/src/acme
git status            # must be clean
node ~/shukka/bin/shukka diff --profile admin       # optional: the diff and the guard's verdict
node ~/shukka/bin/shukka deploy --profile admin
```

Flags: `--allow-replacement` (deploy even if the guard refuses), `--skip-checks` (warns), `--bucket`, `--region`, `--config`, `--dry-run`. `buildEnv` values come from your environment if set, otherwise from Parameter Store `/<project>/prod/<NAME>`.

How credentials are used: your project's own code (checks, build, `npm ci`, synth, smoke) runs with every `AWS_*` variable removed and the AWS config files pointed at empty files. `cdk diff` and `cdk deploy` run with shukka's pinned `cdk` and only a session of your project's bootstrap deploy role, so they are fenced like the pipeline. Upload and release are shukka's own code and use your credentials.

Limits:

- It deploys **only what is on `origin/main`**: it refuses a dirty tree or a `HEAD` that differs from `origin/main`. It fetches first; if GitHub is unreachable it compares with the last `origin/main` you fetched. You cannot push a fix while GitHub is down, so you can only redeploy what was already merged.
- Your principal must be an emergency principal named at bootstrap (default: whoever ran it).
- Services your checks use (`dynamodb-local`) are not started for you; start them or use `--skip-checks`.
- Code that reads `~/.aws` by path is not stopped. Prefer a non-admin emergency principal.
- It does not coordinate with a pipeline run. Do not run both at once.

## v1 limits

- **One hosted zone per project**, by id. Mail domains: any number.
- **No Docker image assets.** shukka's bootstrap has no image repository or image-publishing role, and an assembly with Docker image assets is refused.
- **The cloud assembly must be readable by shukka's pinned `cdk` CLI** (`aws-cdk` 2.1148.0 in this release). If your `aws-cdk-lib` is newer than that CLI understands, the deploy fails with a schema version error until a shukka release bumps the pin.
- **No AWS SSO profiles for bootstrap yet.** shukka runs `cdk` with an empty home directory, where SSO's token cache is not found. Use a profile with long-lived or assumed-role credentials. Exporting short-lived credentials into the environment first (`eval "$(aws configure export-credentials --profile <sso-profile> --format env)"`, then no `--profile`) should work but has not been tested.
- **At most 20 apps** per project.
- One environment (`prod`) per project; EC2 servers only (no ECS or Lambda app deploys).
- The services listed under [What the fence stops](#what-the-fence-stops). Anything else is refused.
- Instances launch only from Amazon-owned AMIs (the fence's default; `shukka bootstrap` has no flag to change it yet).

## Versioning and pins

shukka is versioned by git tags on this repository. `v1.x.y` tags never move. `v1` moves to the newest `v1.x.y` after shukka's CI is green. Release candidates are `v1.0.0-rc.N`. The workflows, the constructs, the CLI and the schema are versioned together.

There are four places a project names a version. Keep them on the same one:

| Where | `@v1` (follow v1) | Pinned |
|---|---|---|
| Caller workflow | `uses: rummykhan/shukka/.github/workflows/pipeline.yml@v1` | `...@v1.2.3` |
| Constructs (infra `package.json` and lockfile) | does not follow; see below | `github:rummykhan/shukka#v1.2.3` |
| CLI | `npx github:rummykhan/shukka#v1 ...` | `#v1.2.3` |
| `shukka.json` `$schema` | `.../shukka/v1/schema/shukka.schema.json` | `.../v1.2.3/...` |

In the caller workflow, `@v1` means every v1 release reaches you on your next run, and `@v1.2.3` means nothing changes until you bump it. A project pinned to v1.0 is not affected by v1.1.

The constructs are different: npm records the commit a git dependency resolved to in `package-lock.json`, so even `#v1` stays on that commit. The constructs move only when you run `npm install github:rummykhan/shukka#<tag>` (or `npm update shukka`) and commit the lockfile. Use an exact tag there, and bump it in the same commit as the workflow pin, so the constructs your stacks are built with and the workflows that deploy them come from the same release.

Pin to **tags only**. Your roles trust `infra.yml` and `ec2.yml` at `refs/tags/v1` and `refs/tags/v1.*` (`shukkaVersions` on `ShukkaAccess`), so a branch or commit SHA in `uses:` is refused by AWS. The file names `pipeline.yml`, `infra.yml` and `ec2.yml` are part of the v1 contract and will not change within v1.

## Cost

shukka adds nothing that bills by the hour. What a project pays for:

- **GitHub Actions minutes.** Public repositories are free. Private repositories on GitHub Free get 2,000 Linux minutes a month, and each job is billed rounded up to the whole minute, so a run costs at least one minute per job it runs. A docs-only merge still runs `plan`, the checks, the builds, the synth and two read-only "changes" jobs, but deploys nothing. Unchanged parts are skipped (no deploy or release job runs for them). v1 does not cache npm downloads between runs. Check your use with `gh run view <id> --repo acme-org/acme --json jobs`, or under Settings, Billing.
- **S3.** App bundles in your deploy bucket (expire them after 30 days) and CDK assets in your bootstrap's asset bucket (old versions expire after 30 days). Cents a month.
- **Free:** IAM roles and policies, the OIDC provider, CloudFormation, SSM Run Command, Parameter Store standard parameters.
- **Your own resources** (servers, tables, the hosted zone at $0.50 a month) cost what they always did.

Set an AWS budget alert, and watch your Actions minutes for the first month.

## Developing shukka

```bash
npm ci
npm run gate      # lint, typecheck, tests, actionlint, shellcheck (the release-script tests need Docker)
node bin/shukka --help
bash test/acceptance/run.sh v1.0.0-rc.N      # end to end on real AWS and GitHub; see test/acceptance/README.md
```

Requirements and design: `docs/factory/v1/`. MIT licence.
