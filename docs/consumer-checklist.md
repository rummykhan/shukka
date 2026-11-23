---
title: Consumer checklist
task: shu-e08
---
# Adopting shukka: checklist

Every step a new project takes, in order, each with its command. The [README](../README.md#adopting-shukka) explains why each one is there; read its [security model](../README.md#security-model) first.

Example values: project `acme`, repository `acme-org/acme`, account `123456789012`, region `us-east-1`, admin profile `admin`, project checkout `~/src/acme`. Replace them with yours. `shukka bootstrap` and `shukka deploy` take `--dry-run`; `shukka diff` changes nothing anyway.

## Before you start

- [ ] Tools on the setup machine: Node 22, `git`, AWS CLI v2, `gh` signed in with admin on the repository, and Docker for the emergency deploy (`shukka diff` and `deploy` run your project's code in containers and refuse without Docker unless `--trust-project-code`).

  ```bash
  node --version && git --version && aws --version && gh auth status && docker info --format '{{.ServerVersion}}'
  ```

- [ ] Admin credentials for the account work (not an SSO profile; see the README's v1 limits).

  ```bash
  aws sts get-caller-identity --profile admin
  ```

- [ ] Pick a project name (and a qualifier: a letter first, 2 to 10 lowercase letters and digits) that is not `shukka`, `cdk`, `cdktoolkit` or `aws`, a prefix of one, or `<reserved>-…`, and is not a prefix of another project in the account, and is not prefixed by one. List the projects shukka knows (if the `Shukka-Account` stack exists):

  ```bash
  aws cloudformation describe-stacks --stack-name Shukka-Account --profile admin \
    --query "Stacks[0].Outputs" --output table
  ```

- [ ] Find the one Route 53 hosted zone the project may change:

  ```bash
  aws route53 list-hosted-zones --profile admin --query "HostedZones[].[Id,Name]" --output table
  ```

- [ ] Find your repository's subject for the roles (use the form your OIDC tokens carry; the immutable one when GitHub gives it):

  ```bash
  gh api repos/acme-org/acme --jq '"\(.owner.login)@\(.owner.id)/\(.name)@\(.id)"'
  ```

## Once per AWS account

- [ ] Account bootstrap (skip if the `Shukka-Account` stack already exists). From outside any project directory:

  ```bash
  cd ~
  npx github:rummykhan/shukka#v1 bootstrap --account --region us-east-1 --profile admin
  ```

  If it says the account already has a GitHub OIDC provider, import it:

  ```bash
  npx github:rummykhan/shukka#v1 bootstrap --account --region us-east-1 --profile admin \
    --oidc-provider-arn arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com
  ```

## In the project repository

- [ ] Write `shukka.json` in the project root (README, step 2), including `fence.hostedZoneIds` (exactly one) and `fence.mailDomains`. Check it parses:

  ```bash
  node -e "JSON.parse(require('fs').readFileSync('shukka.json','utf8'))" && echo ok
  ```

- [ ] Install shukka's constructs and tsx in the infra directory, from the exact release your caller runs (`v1.2.3`; the newest `v1.x.y` if your caller follows `@v1`; `v1.0.0-rc.N` while testing a release candidate), and commit the lockfile:

  ```bash
  cd ~/src/acme/infra
  npm install --save github:rummykhan/shukka#v1.2.3 aws-cdk-lib constructs tsx   # the tag in your caller's uses:
  npm install --save-dev --save-exact aws-cdk@2.1148.0                          # shukka's pinned cdk CLI
  git add package.json package-lock.json
  ```

- [ ] `cdk.json` runs the app with tsx: `"app": "npx tsx bin/app.ts"`.

- [ ] In the CDK app (README, step 3): `shukkaSynthesizer('<qualifier>')` on every stack but the CI stack; a CI stack named exactly `<Project>-Ci` with `shukkaCiSynthesizer('<qualifier>')`, holding only `ShukkaAccess` with your `githubRepo` subject and deploy bucket; `tagProject(app, '<project>')` (not `Tags.of` alone: it misses the launch template CDK makes for `requireImdsv2`, and the fence refuses the untagged create); `applyBoundary(app, '<project>')`. Import from `shukka`, never from files under it. Testing a release candidate: `allowPrerelease: true` on `ShukkaAccess` (never in production), or AWS refuses the pre-release tag.

- [ ] Every stack is named `<project>-...` or `<Project>-...`, at the top level of the app (not inside a CDK `Stage`); every resource you name starts with the project name. Stacks use only the services the fence covers (README, "What the fence stops").

- [ ] Tags use only letters, digits, spaces and `_ . : / = + - @` (no commas, parentheses or `?`); keys have no `=` and do not start with `aws:`.

- [ ] File assets ending `.json`, `.yaml`, `.yml` or `.template` are JSON (no YAML file assets).

- [ ] Nothing in the stacks lets an outside principal in: role trusts only name AWS services, your account's roles, or what `ShukkaAccess` makes; resource policies name no `*` or other account, and services carry `aws:SourceAccount`/`aws:SourceArn`; SNS email subscriptions only to your `fence.mailDomains`. Public resources (function URL auth `NONE`, public bucket) need a run by hand with `allow_replacement` on every merge that deploys the infrastructure.

- [ ] The app passes no ACL on S3 uploads (`s3:PutObjectAcl` is denied, even `ACL: 'private'`).

- [ ] A stack creates the deploy bucket `<project>-deploy-<account>` (a custom `aws.deployBucket` must start with the project name; public access blocked, SSL enforced, 30-day expiry on `<project>/`).

- [ ] The server has the tag `Project=<project>`, an instance role with `AmazonSSMManagedInstanceCore` and read on `s3://<bucket>/<project>/*`, and `bash`, AWS CLI, `curl`, `flock`, systemd (Amazon Linux 2023 has them). No secrets in user data or launch templates.

- [ ] No live context lookups; `cdk.context.json` committed. Check the app synthesizes with no AWS credentials, as the pipeline does:

  ```bash
  cd ~/src/acme/infra
  env -u AWS_PROFILE -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN \
    AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null npx cdk synth --quiet
  git add cdk.context.json
  ```

- [ ] One configure hook per app at `server.configure` (README, step 8): idempotent, enables its units, never starts or restarts them, units point at `/opt/<project>/<app>/current`, writes nothing under `/opt/<project>/<app>` (settings under `/etc/<project>`, root-owned), the app user's writable data outside `/opt/<project>`, prints no secrets.

- [ ] Each app has its bundle script (`build.bundle`), or uses `scripts/bundle.sh` for Next.js standalone output.

- [ ] Commit and push all of the above to `main` **without** the caller workflow yet (nothing deploys).

  ```bash
  cd ~/src/acme && git add -A && git commit -m "Configure shukka" && git push origin main
  ```

## Once per project, with admin credentials

- [ ] Put each `buildEnv` value in Parameter Store as a plain `String`:

  ```bash
  aws ssm put-parameter --name /acme/prod/CONTACT_EMAIL --type String --value hello@acme.example --profile admin
  ```

- [ ] Project bootstrap, from **outside** the project directory:

  ```bash
  cd ~
  npx github:rummykhan/shukka#v1 bootstrap acme --config ~/src/acme/shukka.json --repo acme-org/acme --profile admin --dry-run
  npx github:rummykhan/shukka#v1 bootstrap acme --config ~/src/acme/shukka.json --repo acme-org/acme --profile admin
  ```

  Add `--emergency-principal <role or user ARN>` for each principal that may run `shukka deploy` (default: whoever runs this; the account root is refused). Re-running without it resets the principals to whoever runs it.

  If it refuses because resources named `<project>*` belong to no stack of the project (tables, buckets, queues, topics, functions, log groups, alarms, roles, instance profiles, SES configuration sets, SSM documents), delete or rename them, or choose another project name: the fence would hand them to this project's pipeline.

- [ ] Check the stacks and the repository variables exist:

  ```bash
  aws cloudformation describe-stacks --stack-name Shukka-Boundary-acme --profile admin --query "Stacks[0].StackStatus"
  aws cloudformation describe-stacks --stack-name CDKToolkit-acme --profile admin --query "Stacks[0].StackStatus"
  gh variable list --repo acme-org/acme
  ```

- [ ] Deploy the CI stack by hand with admin credentials, from a clean checkout of `main` you trust, after reading its diff. The pipeline and `shukka deploy` never deploy `<Project>-Ci`: repeat this whenever it changes (the pipeline's diff then says `guard: Acme-Ci changes, and the pipeline never deploys it`):

  ```bash
  cd ~/src/acme/infra && npm ci && npx cdk diff Acme-Ci --profile admin && npx cdk deploy Acme-Ci --profile admin
  for r in infra app diff; do aws iam get-role --role-name acme-shukka-$r --profile admin --query Role.Arn; done
  ```

- [ ] Moving an existing server? Remove or rename any `current` or `previous` in `/opt/<project>/<app>` that is not a symbolic link; the release script refuses to release over it (exit 10).

  ```bash
  aws ssm send-command --document-name AWS-RunShellScript --targets Key=tag:Project,Values=acme \
    --parameters 'commands=["ls -ld /opt/acme/*/current /opt/acme/*/previous"]' --profile admin --query Command.CommandId
  ```

- [ ] Moving existing stacks? No pending change sets on any project stack:

  ```bash
  aws cloudformation list-change-sets --stack-name Acme-Box --profile admin --query "Summaries[].ChangeSetName"
  aws cloudformation delete-change-set --stack-name Acme-Box --change-set-name <name> --profile admin
  ```

## Turn the pipeline on

- [ ] If your organisation restricts actions, allow `rummykhan/shukka` and the actions it pins (`actions/checkout`, `actions/setup-node`, `actions/upload-artifact`, `actions/download-artifact`, `aws-actions/configure-aws-credentials`).

- [ ] Add the caller workflow `.github/workflows/ci.yml` (README, step 7) as the only CI file, remove any other deploying workflow, and push to `main`. The first merge deploys everything.

  ```bash
  cd ~/src/acme && git add .github/workflows/ci.yml && git commit -m "Deploy with shukka" && git push origin main
  gh run watch --repo acme-org/acme
  ```

- [ ] Check the server runs the merged commit:

  ```bash
  git rev-parse origin/main
  aws ssm send-command --document-name AWS-RunShellScript --targets Key=tag:Project,Values=acme \
    --parameters 'commands=["cat /opt/acme/web/current/REVISION"]' --profile admin --query Command.CommandId
  aws ssm list-command-invocations --command-id <id> --details --profile admin \
    --query "CommandInvocations[].CommandPlugins[].Output"
  ```

- [ ] Open a pull request that touches `infra/` and check the diff comment appears.

## Afterwards

- [ ] Protect `main` if your plan allows it: whoever can push to `main` can change the project's resources.
- [ ] Prepare the emergency deploy now, while GitHub is up: a clone at your pinned tag, and one `diff` to build the project image (needs Docker; `--trust-project-code` runs your code on the host instead, able to read your home directory):

  ```bash
  git clone --branch v1.2.3 https://github.com/rummykhan/shukka ~/shukka && (cd ~/shukka && npm ci)
  cd ~/src/acme && node ~/shukka/bin/shukka diff --profile admin
  ```

- [ ] Set an AWS budget alert and watch Actions minutes for the first month.
- [ ] Decide on a pin: `@v1` or `@v1.x.y` in the caller. The constructs stay on the commit in `package-lock.json` until you run `npm install github:rummykhan/shukka#<tag>` and commit the lockfile; bump them with the caller pin, in one commit.
- [ ] Read the policy guard's verdict before ticking `allow_replacement`: it lets both guards through, including roles or resource policies that trust an outside principal.
