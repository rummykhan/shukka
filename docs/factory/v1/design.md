---
status: approved
---
# Design: shukka v1

## Overview

shukka is one public repository with three parts that meet at a single config file in each project.

```
project repo (private)                    rummykhan/shukka (public, tagged v1, v1.x.y)
──────────────────────                    ───────────────────────────────────────────
.github/workflows/ci.yml  ──uses──►  .github/workflows/pipeline.yml   (entry, no AWS)
  (10 lines: on, permissions,             ├─ job plan     : read shukka.json, decide what changed
   uses, with: config)                    ├─ job checks   : project's own commands, no id-token
shukka.json  ◄──read by──────────────     ├─ job build    : build app bundles → artifacts, no id-token
infra/ (CDK)                              ├─ call infra.yml   ── job diff+guard+deploy  (infra role)
  └─ new ShukkaAccess(...)  ◄──npm git dep── lib/ (CDK constructs)
                                          ├─ call ec2.yml     ── job upload+install     (app role)
                                          └─ job smoke    : project's smoke command, no id-token
                                          scripts/   (node, tested; the workflows and the CLI both call these)
                                          box/shukka-release.sh  (runs on the server through SSM)
                                          bin/shukka  (CLI: bootstrap, deploy, diff for laptops)
```

Credentials exist only inside `infra.yml` and `ec2.yml`. Each AWS role trusts only its own file (through the `job_workflow_ref` claim) on the project's `main` branch. No project code is installed or run in `ec2.yml`; `infra.yml` runs the project's CDK app, which is unavoidable and limited by the fence. The fence is a per-project CDK bootstrap whose CloudFormation execution role can touch only that project's resources and can create roles only under the project's permissions boundary.

## Components

**C1. `pipeline.yml`** (reusable workflow, entry point). Inputs: `config` (path, default `shukka.json`), `allow_replacement` (bool), `force` (bool: deploy everything regardless of changed paths). Jobs: `plan` → `checks` and `build` in parallel → `infra` (calls `infra.yml`) → `app` (calls `ec2.yml`, one matrix entry per app) → `smoke`. On `pull_request`: `plan`, `checks`, and `diff` (calls `infra.yml` in diff mode with the read-only role). Every job sets its own `permissions`; only the two nested workflows get `id-token: write`.

**C2. `infra.yml`** (nested reusable workflow). Modes `diff` and `deploy`. Steps: checkout, `npm ci` in the infra directory, assume role, `cdk diff --no-color` to a file and the step summary, guard, then (deploy mode) `cdk deploy --all --require-approval never`. In diff mode it posts the diff and the guard verdict as a pull-request comment (updated in place) and never fails the check for a destructive diff; it says the merge will stop.

**C3. `ec2.yml`** (nested reusable workflow). Downloads the build artifact for one app, checks out the repository (no install, no build) to take the configure hook from git rather than from the artifact, assumes the app role, uploads the bundle to `s3://<bucket>/<project>/<app>/<sha>.tgz`, sends `box/shukka-release.sh` with arguments through SSM Run Command to instances tagged `Project=<project>`, waits, prints output, fails if the script failed. Concurrency group `shukka-<project>-<app>`, `cancel-in-progress: false`.

**C4. `box/shukka-release.sh`** (runs on the server as root). Release manager for one app: download, unpack to a new release directory, run the project's configure hook, switch the `current` symlink, restart the app's units, health-check, roll back on failure, prune old releases. Knows nothing about Trendigle.

**C5. `lib/` CDK constructs** (TypeScript, peer dependency `aws-cdk-lib ^2.170`, `constructs ^10`):
- `ShukkaAccess`: GitHub OIDC provider (create or import), the `infra`, `app` and `diff` roles, the deploy bucket's permissions.
- `ShukkaBoundary`: the project's permissions boundary policy and execution policy (also used by `shukka bootstrap`).
- `shukkaSynthesizer(project)`: a `DefaultStackSynthesizer` with the project's qualifier, so stacks deploy through the project's bootstrap.

**C6. `scripts/`** (Node 22, no runtime dependencies beyond the AWS SDK v3 clients they need): `config.mjs` (load and validate `shukka.json`), `changed.mjs` (what changed since the last deployed commit), `guard.mjs` (port of today's `diff-guard.sh`), `upload.mjs`, `release.mjs` (SSM send and wait). Workflows call `node <shukka>/scripts/x.mjs`; the CLI calls the same modules.

**C7. `bin/shukka`** (CLI, run with `npx github:rummykhan/shukka#v1 <command>`): `bootstrap` (once per project, admin credentials: deploys the boundary stack, then `cdk bootstrap` with the project qualifier and execution policy), `diff`, `deploy` (emergency path: same guard, upload and release, using the caller's profile; refuses unless the working tree is clean and equals `origin/main`).

**C8. Tests** (`test/`, run in shukka's own CI): guard against recorded `cdk diff` outputs (today's twelve cases plus the security reviewer's real samples), construct snapshot and assertion tests on the synthesized trust and boundary policies, `shukka-release.sh` in a Docker container with two fake apps, `actionlint` on the workflows, config validation.

**Trendigle changes** (consumer, separate branch in its repo): `shukka.json`; `ci.yml` replaced by the caller; Ci stack uses `ShukkaAccess` (old roles removed after the switch); every stack uses `shukkaSynthesizer('trendigle')`; `box/install.sh` becomes two configure hooks (`box/configure-app.sh`, `box/configure-admin.sh`) and its systemd units point at `.../current`; `deploy.sh` reduced to a pointer at `shukka deploy`; `diff-guard.sh` and its test removed.

## Data model

No database. State that exists:

- **Bundles**: `s3://<deployBucket>/<project>/<app>/<sha>.tgz`, lifecycle rule expiring objects after 30 days (the server keeps its own copies). Trendigle's existing bucket `trendigle-prod-deploy-<account>` is reused.
- **On the server**, per app: `/opt/<project>/<app>/releases/<sha>/` (unpacked bundle plus `REVISION` containing the sha), `/opt/<project>/<app>/current` → one release, `/opt/<project>/<app>/previous` → the one before. Last 5 releases kept.
- **Last deployed commit**: read from the server (`current/REVISION`) by `changed.mjs` through SSM; for infrastructure, the commit is recorded in each stack's `shukka:revision` tag at deploy and read back with `DescribeStacks`.
- **Existing Trendigle data**: untouched. The first release migrates `/opt/trendigle/app` into `releases/<sha>` by deploying normally; the old directory is removed by the configure hook once units point at `current`.

## Contracts

### `shukka.json` (in the project root)

```json
{
  "$schema": "https://raw.githubusercontent.com/rummykhan/shukka/v1/schema/shukka.schema.json",
  "project": "trendigle",
  "qualifier": "trendigle",
  "aws": { "account": "818221194501", "region": "us-east-1" },
  "node": "22",
  "checks": [
    { "name": "app",   "dir": "implementation/app",   "run": ["npm ci", "npm run lint", "npm run typecheck", "npm test", "npm run build"], "services": ["dynamodb-local"] },
    { "name": "admin", "dir": "implementation/admin", "run": ["npm ci", "npm run lint", "npm run typecheck", "npm test", "npm run build"], "services": ["dynamodb-local"] }
  ],
  "infra": { "dir": "implementation/infra", "paths": ["implementation/infra/**", "implementation/app/src/core/tables.json"] },
  "apps": [
    {
      "name": "app",
      "paths": ["implementation/app/**"],
      "build": { "dir": "implementation/app", "run": ["npm ci", "npm run build"], "bundle": "scripts/bundle.sh", "env": { "APP_URL": "https://trendigle.com" }, "buildEnv": ["LEGAL_ENTITY", "CONTACT_EMAIL"] },
      "server": { "configure": "implementation/infra/box/configure-app.sh", "units": ["trendigle", "trendigle-tick"], "health": "http://127.0.0.1:3200/login" }
    },
    {
      "name": "admin",
      "paths": ["implementation/admin/**"],
      "build": { "dir": "implementation/admin", "run": ["npm ci", "npm run build"], "bundle": "scripts/bundle.sh" },
      "server": { "configure": "implementation/infra/box/configure-admin.sh", "units": ["trendigle-admin"], "health": "http://127.0.0.1:3201/login" }
    }
  ],
  "smoke": { "run": "bash implementation/infra/smoke.sh" },
  "alwaysDeploy": false
}
```

Rules: `project` and `qualifier` are `^[a-z][a-z0-9-]{1,20}$` and qualifier `^[a-z0-9]{1,10}$` (CDK limit); role names derive from them (`<project>-shukka-infra`, `-app`, `-diff`), so no ARNs appear in the file. `bundle` is a project script run in the build dir that must print the path of a directory to tar; `scripts/bundle.sh` is provided by shukka for Next.js standalone output (copies `.next/static` and `public`, deletes `.env*`). `buildEnv` names are non-secret build-time values the build reads from GitHub repository variables of the same name (D9); `shukka bootstrap` copies them there from `/<project>/prod/<NAME>`.

### Caller workflow (the whole project CI file)

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

### `ShukkaAccess` construct

```ts
export interface ShukkaAccessProps {
  project: string;                 // matches shukka.json
  githubRepo: string;              // subject repo segment, e.g. 'trendigle@220634492/trendigle@1462395046' or 'org/repo'
  shukkaVersions?: string;         // default 'v1*' → job_workflow_ref must match rummykhan/shukka/.github/workflows/<file>@refs/tags/v1*
  oidcProviderArn?: string;        // import instead of create when the account already has one
  deployBucket: s3.IBucket;
  instanceTag?: { key: string; value: string }; // default { Project: project }
  ssmPath?: string;                // default `/${project}/prod`; app role may read it
}
export class ShukkaAccess extends Construct {
  readonly infraRole: iam.Role; readonly appRole: iam.Role; readonly diffRole: iam.Role;
}
```

Trust, for each role, all conditions together:
- `aud = sts.amazonaws.com`;
- `sub` StringEquals `repo:<githubRepo>:ref:refs/heads/main` (infra, app) or `repo:<githubRepo>:pull_request` (diff); the default subject is used, no customisation (spike S1);
- `job_workflow_ref` StringLike `rummykhan/shukka/.github/workflows/infra.yml@refs/tags/<shukkaVersions>` (infra, diff) or `.../ec2.yml@...` (app).

Permissions:
- **infra**: `sts:AssumeRole` on the project-qualifier bootstrap roles `cdk-<qualifier>-{deploy,file-publishing}-role-*` only. Not the lookup role: the stock one has account-wide ReadOnlyAccess, and `cdk.context.json` is committed so deploys need no live lookup (security review of shu-7nw, 2026-11-22). The bootstrap itself is shukka's own template, whose deploy role can change only the project's stacks with the project's own execution role (shu-9bj.2).
- **app**: `s3:PutObject` on `<bucket>/<project>/*`; `ssm:SendCommand` on `AWS-RunShellScript` and on instances with the tag; `ssm:GetCommandInvocation`, `ec2:DescribeInstances`; `ssm:GetParameter` on `<ssmPath>/*`.
- **diff**: `cloudformation:GetTemplate`, `DescribeStacks` on `arn:aws:cloudformation:<region>:<account>:stack/<StackPrefix>*/*`; `ssm:GetParameter` on `/cdk-bootstrap/<qualifier>/version`. Nothing else (no lookup role: `cdk.context.json` is committed).

### `ShukkaBoundary` / execution policy

- **Execution policy** (attached to the project's CloudFormation execution role): allow the services the project uses, restricted to resources named with the project prefix (`<project>*`, `<Project>-*` stack-generated names, case variants listed explicitly), or tagged `Project=<project>` where the service supports tag conditions (EC2), or listed by id in config (Route 53 hosted zone).
- **Role creation**: `iam:CreateRole`, `iam:PutRolePermissionsBoundary`, `iam:AttachRolePolicy` and `iam:PutRolePolicy` allowed only with `iam:PermissionsBoundary = <boundary ARN>`. A deny on deleting or changing the boundary itself.
- **The boundary**: the same resource limits, applied to every role the project's stacks create (CDK `PermissionsBoundary.of(app).apply`).

The exact documents are in `docs/factory/v1/spikes/s2/policy.py` (spike S2, 58 simulator cases pass): the execution policy is two managed policies (6,144-character limit); the boundary grants no IAM or EC2 management. Project names must not be prefixes of one another.

### `Shukka-Account` stack (once per AWS account)

Deployed with admin credentials by `shukka bootstrap --account`. Owns the GitHub OIDC provider (`token.actions.githubusercontent.com`, client `sts.amazonaws.com`) and outputs its ARN and the list of project names bootstrapped in the account. Projects import the provider; no project stack creates or changes it.

### `shukka-release.sh` (on the server)

```
shukka-release.sh --project P --app A --sha SHA --bucket B --region R
                  --configure-key <s3 key of the hook>     (uploaded by ec2.yml from the git checkout, never from the bundle)
                  --units "u1 u2" --health URL [--keep 5] [--health-timeout 60]
exit 0  = new release live and healthy
exit 10 = download or unpack failed      (nothing changed)
exit 11 = configure hook failed          (nothing switched)
exit 12 = unhealthy, rolled back, previous healthy
exit 13 = unhealthy, rollback also unhealthy (manual attention)
stdout last line: "shukka: <project>/<app> <old-sha> -> <new-sha> <result>"
```

Where the hook comes from (decided 2026-11-22 after the security review of shu-9bj.1 found the two readings of this contract): `ec2.yml` (through `scripts/release.mjs`) reads the hook from the **git checkout** at the config's `server.configure` path and uploads it to `s3://<bucket>/<project>/<app>/<sha>.configure.sh`; `shukka-release.sh` downloads that object to `/opt/<project>/<app>/hooks/<sha>.sh` (outside every release directory, root-owned, mode 0700) and runs only that file. A file at the same path inside the bundle is never executed.

Configure hook contract: called as `hook.sh <release-dir>` with `PROJECT`, `APP`, `SHA`, `REGION` in the environment, as root. It writes settings files, users and systemd units (pointing at `/opt/<project>/<app>/current`), and must be idempotent. It must not start or restart the app's units; the release script does that after the switch. A release whose hook fails is deleted.

Health: HTTP GET every 2 s until 2xx/3xx or the timeout; units must be `active`.

Concurrency on the box: `flock /opt/<project>/<app>/.lock`, so two releases of one app never interleave; different apps do not wait for each other.

### Guard (`scripts/guard.mjs`)

Input: full `cdk diff --no-color` output. Exit 0 = safe. Exit 1 = destructive or incomplete; prints the offending lines. Same rules as `diff-guard.sh` today, plus: a `[-] Output` line is not destructive. `--allow` turns exit 1 into 0 with a notice.

## Key flows

**Merge, both infra and app changed.** `plan` reads config, computes changed paths since the deployed revisions → `checks` + `build` (parallel, no credentials; build uploads `bundle-<app>` artifacts) → `infra` deploy (diff, guard, deploy; stacks tagged `shukka:revision=<sha>`) → `app` matrix (upload, release with rollback) → `smoke`. About 6 billed minutes if checks and build share a job per app (D8).

**Merge, docs only.** `plan` finds no infra or app paths changed → `checks` still run (cheap) → no deploy jobs → green.

**Destructive diff on merge.** `infra` stops after the guard; `app` and `smoke` skip; summary names the resources and says to rerun by hand on `main` with `allow_replacement`. The owner reads the diff and reruns.

**Health check fails.** `shukka-release.sh` switches `current` back to `previous`, restarts, health-checks the old one (exit 12) → `ec2.yml` fails with the release script's last line → `smoke` skipped → run red, site on the old version.

**Pull request changing infra.** `diff` job assumes the diff role (pull_request subject, `infra.yml` workflow), runs `cdk diff`, comments the diff and "this merge will stop: replaces Box" if the guard would refuse.

**GitHub down.** Owner runs `npx github:rummykhan/shukka#v1 deploy --profile stelking` from a clean checkout of `origin/main`: same checks optional (`--skip-checks` with a warning), same guard, same upload and release, using the owner's credentials (which do not pass the trust policies, so it uses the profile directly).

## Decisions

| # | Decision | Alternatives considered | Why |
|---|---|---|---|
| D1 | One public repo holding workflows, constructs, scripts and CLI | npm package for constructs + separate workflow repo; private repo | Workflows cannot be shipped by npm; private reusable workflows cannot be shared across organisations (Trendigle and Orbitary differ). One tag versions everything together |
| D2 | Install the construct as a git dependency from the tag (`github:rummykhan/shukka#v1.x.y`) | Publish to npm | No npm account on this machine; one artifact; can publish later without breaking consumers |
| D3 | Credentials only in nested workflows `infra.yml` and `ec2.yml`; each role trusts its own file via `job_workflow_ref` | One workflow with job-level `if`; separate repos per stage | Job identity is otherwise indistinguishable inside one workflow (trn-a2r). Hard to reverse once projects depend on the file names: **file names are part of the v1 contract** |
| D4 | Build on the runner without credentials; the app job only uploads and installs | Build inside the credentialed job (today) | A compromised dependency in the build reaches nothing in AWS |
| D5 | Per-project CDK bootstrap (qualifier) with a limited execution policy and a permissions boundary | Keep the shared admin bootstrap; one account per project; tag-based ABAC only | Separate accounts are the cleanest fence but cost setup and moving data; ABAC is uneven across services. Prefix plus boundary works for our services. **Hard to reverse**: moving stacks to a new qualifier changes their asset buckets and execution role |
| D6 | Release directories with a `current` symlink and automatic rollback, on the existing SSM path | Blue-green on two ports behind Caddy; replace the instance (AMI) | Symlink swap is seconds and needs no proxy change; blue-green doubles memory on a t4g.micro; AMI baking is slow and costs |
| D7 | Last deployed revision read from AWS (stack tags, server `REVISION`) | Compare with `github.event.before` | A failed or skipped deploy would otherwise be forgotten by the next docs-only merge |
| D8 | Checks and build for an app share one job when the project marks them `sameJob` (default true) | Always separate | Halves runner minutes; build output from the checked commit. Still no credentials in that job |
| D9 | Build-time values (`buildEnv`) come from GitHub repository variables, copied from Parameter Store by `shukka bootstrap`; secrets are never build-time | Fetch from Parameter Store in a credentialed step before the build; build inside the credentialed job | Keeps the build job credential-free (D4). Trendigle's two build-time values are public text on its legal pages |
| D10 | Pull-request diff through a template-only read role | No PR diff; reuse lookup role | The lookup role has account-wide ReadOnlyAccess (includes reading S3 objects); templates are already in the repo |
| D11 | `shukka.json` is the single config, read by workflows and CLI | Workflow inputs only | The emergency CLI must deploy exactly like CI; workflow inputs cannot be read from a laptop |

## Risks

| Risk | Reduced or detected by |
|---|---|
| `job_workflow_ref` with nested reusable workflows and immutable IDs behaves differently from the docs | Settled by spike S1 (docs/factory/v1/spikes/s1-oidc.md): it works as designed |
| A compromised build dependency plants code that runs as root on the server | The configure hook is taken from the git checkout in `ec2.yml`, never from the artifact; the app itself runs as an unprivileged user |
| The OIDC provider is deleted while moving it out of Trendigle's Ci stack | Two steps under the old admin role: `RETAIN` first, then remove (the guard shows it; allowed by hand); import into `Shukka-Account` straight after; `iam list-open-id-connect-providers` checked between steps |
| The limited execution role cannot update or roll back an existing Trendigle resource, leaving a stack in `UPDATE_ROLLBACK_FAILED` | Spike S2 simulates every action on every physical resource; first deploy through the new bootstrap is a no-change deploy; switch one low-risk stack (Dns) first; keep the old admin bootstrap until all four have deployed cleanly through the new one |
| Moving stacks to the new qualifier triggers resource replacement | `cdk diff` must show only metadata/asset changes; the guard stops anything else |
| First release migration on the box takes the site down | Done in a quiet moment; configure hooks tested in the container first; rollback leaves `/opt/trendigle/app` intact until the second successful release |
| A tag push to rummykhan/shukka changes what deploys every project | Projects pin `@v1` (moving major tag) by choice; shukka CI must pass before a tag; projects that want stability pin `@v1.x.y` |
| Public repo leaks something | No secrets by design; account IDs and role names only appear in consumer repos; a secret scan in shukka CI |
| GitHub's free minutes change | Measured per run in the summary; budget alert note in README |

## Test strategy

- **Builders (unit and integration):** guard cases (recorded real outputs, colour, empty, incomplete, output-only removal); config schema (valid, each invalid field); construct assertions (trust conditions exactly as specified for each role; no `*` actions; boundary required on role creation); `changed.mjs` against a fixture git history; `shukka-release.sh` in Docker with two fake apps: success, configure failure, unhealthy then rollback, rollback also unhealthy, concurrent releases of one app, one app's release leaves the other running, prune keeps 5.
- **QA tester (acceptance):** a test consumer repository (private, owner's account) calling `pipeline.yml@<branch tag>` against a throwaway stack set in the shared account: merge deploys; branch and PR cannot assume deploy roles (observed `AccessDenied`); the build job cannot assume infra role; destructive change stops; docs-only merge deploys nothing. Throwaway resources deleted at the end.
- **Validator (by hand):** Trendigle's switch-over merge in a quiet moment: diff contents, guard, app live on new release, `REVISION` matches, smoke green; one deliberate unhealthy release on Trendigle's admin app (owner's leave required, see prerequisites) or on the test consumer if not given.
- **Handles:** exit codes and last line of `shukka-release.sh`; step summary headings `### Infrastructure changes`, `### Guard`; PR comment marker `<!-- shukka:diff -->`.

## Rollout

1. Spikes S1 (OIDC claims) and S2 (execution policy) — results may change D3 and D5 before building.
2. Build shukka v1 in the public repo with its tests; tag `v1.0.0-rc.N` on a branch for the test consumer.
3. Acceptance against the test consumer and throwaway stacks.
4. `shukka bootstrap --account` (OIDC provider into `Shukka-Account`, after Trendigle's Ci stack has released it as in the risk above), then `shukka bootstrap trendigle` (owner's leave given: P4); Trendigle Ci stack with `ShukkaAccess` deployed by hand (P3), both old and new roles present.
5. Trendigle branch: caller workflow, `shukka.json`, synthesizer switch, configure hooks. PR shows the diff; merge in a quiet moment with the owner's approval. Stacks move qualifier one at a time if the diff is large.
6. After two clean deploys: remove old roles and `diff-guard.sh`; tag `v1.0.0` and `v1`.

Rollback: revert the Trendigle merge; the old roles and the default bootstrap still exist until step 6, so the previous `ci.yml` works again. On the box, `current` still points at a release that works, and the old units can be restored by the previous `install.sh`.

## Requirement coverage

| Requirement | Where |
|---|---|
| R1 reusable workflow | C1, caller contract, D1, D11 |
| R2 deploy access construct | C5 `ShukkaAccess`, D3, S1 |
| R3 fence | C5 `ShukkaBoundary`, `shukka bootstrap`, D5, S2 |
| R4 destructive stop, PR diff | C2, guard contract, D10 |
| R5 EC2 with rollback, multi-app | C3, C4, release contract, D6 |
| R6 smoke | C1 `smoke` job |
| R7 cheap | D7, D8, changed-paths plan |
| R8 emergency deploy | C7 `shukka deploy`, D11 |
| R9 Trendigle uses it | Trendigle changes, Rollout 4–6 |
| R10 shukka's own tests | C8, test strategy |
