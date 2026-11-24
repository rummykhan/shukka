# Acceptance suite (shu-95y; probes reworked by shu-9bj.3 for the credential-free synth)

Runs shukka the way a consumer does and checks the result against `docs/factory/v1/requirements.md`
and the epic's success criteria. Written from the requirements and the design's contracts, not from
the implementation. Not part of the gate: it needs the owner's GitHub login and the AWS account.

```bash
bash test/acceptance/run.sh v1.0.0-rc.1     # everything, then teardown (about 1.5 to 2 hours)
bash test/acceptance/run.sh --list          # every case id, one line each (with the task that last rewrote it)
bash test/acceptance/run.sh --teardown      # remove leftovers of a run that was killed
```

Needs `gh` signed in as the owner, AWS profile `stelking` (override with `AWS_PROFILE`), `jq`, `git`,
Node 22, `curl`, `perl`. Exit 0 only when every case passed and teardown left nothing behind. The log,
the `RESULT` lines and every run's log and job list are kept in the run directory it prints.

## What a run does

| Phase | What happens | Cases |
|---|---|---|
| preflight | tools, the account (read from `aws sts get-caller-identity`, never written in a file), the rc tag exists, the test repo is private, **no leftovers of an earlier run** (it stops rather than delete them) | |
| A setup | throwaway hosted zone; buildEnv parameter; stand-in project; consumer rendered and cloned (it imports the account's existing GitHub OIDC provider by ARN); `shukka bootstrap shukkatest`; `Shukkatest-Ci` deployed by hand; baseline pushed to main (the first merge) | R1, R2, R3, R5, R6 basics, the planted bundle hook |
| B pull request | one PR: an app change, a harmless infra change, the probe workflows and the in-CDK probe (it runs in the PR's synth job and must find nothing); then a destructive push to it. The branch and a tag carry the probes too | R1, R2, R4 |
| C own workflow | the consumer's own workflow on main asks for each role with its own OIDC token, then is removed | R2 |
| D fence | a merge adds `Shukkatest-Escape` (changes the stand-in) and runs the in-CDK probe in the merge's synth job (must find nothing); the box's role reads at Trendigle; then removed. Cases read what the infra, deploy and diff roles may do from IAM (simulator) | R3 |
| D2 assembly | a merge whose CDK code plants a file asset built by a command (`settings.plantExecutableAsset`); the deploy job must refuse the assembly; then removed | R3, R2 |
| E docs only | README edit merged | R7 |
| F destructive | table renamed (replacement) merged; then a manual run with `allow_replacement` | R4 |
| G rollback | web made unhealthy and merged; then fixed | R5, R7 |
| H smoke | web page loses the smoke marker (healthy release, failing smoke); then fixed | R6 |
| I serialised | two web merges in quick succession; ordering read from the box (SSM's record of each release command, the release's REVISION time), not from job start times | R5 |
| J emergency | caller workflow disabled; `shukka deploy` from this machine: a change, a dirty tree, an unpushed commit, a destructive change, an unhealthy release; workflow re-enabled | R8 |
| K shukka's tests | shukka's CI result on the rc commit; shukka's tests against loosened trust conditions and a guard that always says safe (local clone) | R10 |
| teardown | always, from an `EXIT` trap, even after a failure or Ctrl-C. First disables every workflow in the test consumer, cancels queued and running runs and waits for them to end; then waits for each stack to leave any `*_IN_PROGRESS` state before deleting it (except `REVIEW_IN_PROGRESS`, a change set never executed, which it deletes at once), retrying the delete | |
| T | after teardown: nothing left, zone deleted in time, OIDC provider and default bootstrap untouched | SC9 |

Phases after A need A; if A fails they are reported `BLOCKED` and teardown still runs. K needs only
GitHub and npm. Cases inside a phase read what the phase recorded; the order is fixed because they
share one deployed project (a fresh project per case would take hours and several hosted zones).

## Safety rules the code enforces

- Everything created is named `shukkatest*` (bootstrap: `cdk-shukkatest-*`; the stand-in "other
  project": `standin-shukkatest-<run>`), except shukka bootstrap's two stacks, which are matched by
  their exact names `CDKToolkit-shukkatest` and `Shukka-Boundary-shukkatest` (never `CDKToolkit` or
  another project's) and tagged `Project=shukkatest` (stand-in:
  `Project=shukkatest-standin`). Every delete goes through `require_ours`.
- Trendigle and Orbitary: Trendigle's table and bucket are only *read* (DescribeTable, a one-key
  listing) with shukkatest's credentials, to observe refusals. Writes are only ever attempted on
  shukkatest's own resources and the stand-in. The default `CDKToolkit` stack is fingerprinted before
  and compared after.
- `Shukka-Account` is never created or deleted: it owns the account's shared GitHub OIDC provider and
  comes after Trendigle's Ci stack releases it (shu-li5, epic 2). `shukka bootstrap --account` is not
  run. shukkatest imports the existing provider by ARN.
- The only repository pushed to (force-push of main, probe branch and tag) is
  `rummykhan/shukka-consumer-test`, a constant; every push checks the clone's `origin` first.
- The caller workflow is left disabled after teardown, so nothing deploys between runs; setup enables
  it again just before its first merge.
- The throwaway hosted zone is created in setup and deleted in teardown (free when deleted within
  12 hours); case `SC9-hosted-zone-deleted-within-run` checks the timing.
- Teardown works from discovery (names and tags), not only this run's state, so `--teardown` cleans up
  after a crash. If project stacks cannot be deleted it leaves the bootstrap in place (deleting it
  would orphan them), prints `LEFTOVER` lines and exits non-zero: stop and clean up by hand.
- Nothing committed holds the account number: the consumer's files use placeholders filled at run
  time (`123456789012` appears only in examples and in leftover reports).

## The test consumer (`consumer/`)

Pushed (force, a fresh history each run) to `rummykhan/shukka-consumer-test`:

- `.github/workflows/ci.yml`: the caller from the design, pinned to the rc tag. The only CI file.
- `shukka.json`: project and qualifier `shukkatest`, one check, infra in `infra/`, two apps (`web` with a
  buildEnv value, `api`), smoke `bash smoke/smoke.sh`.
- `infra/`: CDK app (JavaScript, run with tsx so the TypeScript in shukka's git dependency loads).
  `Shukkatest-Ci` (ShukkaAccess, provider imported by ARN) and `Shukkatest-Box` (t4g.nano instance with
  IMDSv2 launch template, elastic IP, security group, role `shukkatest-box` and profile, table, deploy
  bucket, `box.<zone>` record). `settings.json` is what cases edit. The default VPC is used by id, so
  no context lookup is needed.
- `apps/web`, `apps/api`: tiny Python servers (`/health`, `/version`, `/`) that need nothing installed
  on Amazon Linux 2023. `health.json` `{"healthy": false}` makes a release unhealthy.
- `probe/planted-configure.sh`: copied by the web build to `box/configure.sh` inside the bundle (a
  compromised dependency's hook); if it ever runs it leaves `/var/tmp/shukkatest-planted-hook-ran`.
- `box/configure.sh`: the configure hook (user and systemd unit pointing at `current`; never starts it).
- `smoke/smoke.sh`: finds the box by asking the zone's Route 53 name server directly (the zone is not
  delegated), checks both `/health` and the web page's marker.
- `probe/assume.sh`: asks for every role in `probe/targets.json` `.roles` (shukka's infra, app and diff
  roles; the project's CDK deploy and lookup roles; the default bootstrap's deploy and lookup roles)
  with the job's own OIDC token and prints `RESULT <case>-<role> DENIED|ALLOWED|ERROR` and the token's
  claims (never the token). Called by the build and checks commands (a compromised dependency) and by
  the probe workflows.
- `probe/escape.sh`: runs inside the CDK app when `infra/probe.on` exists. Since shu-9zr the project's
  code runs only in infra.yml's `synth` job (no `id-token`); the credentialed jobs run shukka's own cdk
  on the downloaded assembly. So the probe reports what that code holds: `RESULT <p>-oidc
  NO-TOKEN|TOKEN`, `RESULT <p>-aws NO-CREDS|CREDS`, `RESULT <p>-github-token NO-TOKEN|TOKEN`, with
  `<p>` = `R3-merge-synth` on main and `R4-pr-synth` on a pull request. With a token or credentials it
  also tries what they reach, so a failure comes with evidence.
- `infra/bin/app.mjs` with `settings.plantExecutableAsset`: after synthesis adds a file asset whose
  source is a command (`source.executable`) to every asset manifest, as a compromised CDK dependency
  would. The command prints a marker computed by the shell (`...-RAN-42`), so the marker is in a log
  only if the command ran.
- `probe/workflows/`: copied into `.github/workflows/` only while the trust cases run.

## Coverage

Every acceptance line of R1-R8 and R10, and every success criterion of epic shu-9bj.

| Requirement / criterion | Case(s) |
|---|---|
| R1.1 caller is the only CI file; PRs run checks; merges run checks, infra deploy, app deploy, smoke | `R1-caller-is-the-whole-ci`, `R1-merge-deploys-full-chain`, `R1-pr-runs-checks-not-deploy`, `R1-build-env-from-variables` |
| R1.2 a project pinned to a version is unaffected by newer ones | `R1-pinned-to-rc-tag` (the run resolved every shukka workflow to the pinned tag's commit). Publishing a newer tag mid-run is **manual** (the suite does not move tags on the public repo) |
| R2.1 non-main branch, pull request or tag cannot assume either role | `R2-branch-cannot-assume-roles`, `R2-pr-cannot-assume-roles`, `R2-tag-cannot-assume-roles` (consumer's own workflow with a real OIDC token: shukka's three roles and the CDK deploy and lookup roles), `R2-infra-yml-refused-off-main` (shukka's infra.yml itself, so only the subject differs; read from its `changes` job), `R4-pr-synth-gets-no-credentials` |
| R2.2 a step that builds or tests app code cannot assume the infra role (trn-a2r) | `R2-build-job-cannot-assume`, `R2-checks-job-cannot-assume` (those jobs have no token endpoint: DENIED), `R2-own-workflow-on-main-refused` (a job that does hold a real token on main, refused by `job_workflow_ref`), `R3-merge-synth-gets-no-credentials` (the project's CDK code holds nothing), `R3-planted-executable-asset-stops-merge` |
| R2.3 an existing OIDC provider is reused, not duplicated | `R2-oidc-provider-not-duplicated` (the Shukka-Account output is checked only if that stack already exists), `R2-oidc-provider-intact-after-run`. `shukka bootstrap --account`: **after shu-li5** (epic 2), not run here |
| R3.1 pipeline credentials refused on another project's stack, table, bucket | `R3-merge-synth-gets-no-credentials` (observed: project code on a merge holds no token or credentials), `R3-execution-role-refuses-other-project` (observed end to end: the merge is red, the stand-in unchanged), `R3-box-role-refused-on-trendigle` (observed from the box), `R3-planted-executable-asset-stops-merge` (observed: an asset that runs a command is refused before any role is assumed), `R3-pipeline-creds-refused-on-other-project` and `R3-pipeline-creds-refused-on-trendigle` (**IAM simulator, admin side**: see below), `R4-pr-code-gets-no-write-credentials` (simulator) |
| R3.2 the project's own stacks deploy through the fence | `R3-own-stacks-through-fence`, `R1-merge-deploys-full-chain`, `SC1-throwaway-project-resources`, `R3-default-bootstrap-untouched`, `R3-default-bootstrap-intact-after-run`. Trendigle's own four stacks: epic shu-li0 |
| R4.1 a removing/replacing diff stops the merge, names the resources, says how to proceed | `R4-destructive-change-stops-merge`, `R4-pr-diff-comment-updated-in-place`. The `### Infrastructure changes` / `### Guard` summary headings are **manual** (no API returns job summaries; the case prints the run to open) |
| R4.2 rerun by hand with allow deploys it | `R4-allow-replacement-deploys` |
| R4.3 PR shows the diff, PR code gets no credentials that can change anything | `R4-pr-diff-comment` (diff job and the separate comment job), `R4-pr-diff-comment-updated-in-place`, `R4-pr-synth-gets-no-credentials` (observed: the PR's own code holds no token, credentials or GitHub token), `R4-pr-code-gets-no-write-credentials` (the diff role, held only by shukka's code: IAM simulator) |
| R4 stateful resources retained by default | `R4-allow-replacement-deploys` (the replaced table is retained) |
| R5.1 failing health check: previous version serving, run red, log shows both | `R5-unhealthy-release-rolls-back`, `R8-cli-rolls-back-unhealthy` |
| R5 the configure hook comes from git, never from the bundle (design, after the shu-9bj.1 review) | `R5-bundle-hook-never-runs` |
| R5.2 the server reports the merged commit | `R5-server-reports-merged-commit`, `R5-next-merge-after-rollback-deploys` |
| R5.3 two quick merges run one after the other, later commit live | `R5-quick-merges-serialised` |
| R5.4 deploying one app leaves the others running | `R5-other-app-keeps-running` |
| R6.1 smoke failure: red, says live but failing smoke | `R6-smoke-failure-turns-run-red`, `R6-smoke-runs-against-live-address` |
| R7.1 runner minutes inside the Free allowance over a month | **manual**: needs a month of Trendigle merges (`gh api /repos/trendigle/trendigle/actions/runs` timing) |
| R7.2 a docs-only merge runs no deploy job | `R7-docs-only-merge-deploys-nothing` |
| R7 unchanged parts skipped / caching | `R7-unchanged-parts-skipped`; dependency caching is **manual** (read a second run's log for cache hits) |
| R8.1 emergency deploy from a laptop: same commit, same guard, same health check | `R8-cli-deploys-head-without-actions`, `R8-cli-refuses-unclean-checkout`, `R8-cli-guard-stops-destructive`, `R8-cli-rolls-back-unhealthy`. "Following the README" is **manual** (a person reads it) |
| R9 Trendigle uses it | out of scope here: epic shu-li0 |
| R10 / R10.1 shukka's own tests in its CI catch a loosened trust policy or a broken guard | `R10-shukka-ci-green-on-rc`, `R10-loosened-trust-fails-tests`, `R10-broken-guard-fails-tests` |
| SC1 test consumer (caller + shukka.json only) deploys shukkatest on merge from an rc tag | `R1-caller-is-the-whole-ci`, `R1-merge-deploys-full-chain`, `SC1-throwaway-project-resources` |
| SC2 PR shows the diff as a comment and cannot assume the deploy roles | `R4-pr-diff-comment`, `R2-pr-cannot-assume-roles`, `R4-pr-synth-gets-no-credentials`, `R4-pr-code-gets-no-write-credentials` |
| SC3 a job that builds app code cannot assume the infra role (observed) | `R2-build-job-cannot-assume`, `R2-own-workflow-on-main-refused`, `R3-merge-synth-gets-no-credentials` |
| SC4 shukkatest's pipeline refused on a Trendigle resource | `R3-box-role-refused-on-trendigle` (observed), `R3-pipeline-creds-refused-on-trendigle` (simulator) |
| SC5 destructive change stops the merge; manual run with allow deploys it | `R4-destructive-change-stops-merge`, `R4-allow-replacement-deploys` |
| SC6 unhealthy release rolls back, run red | `R5-unhealthy-release-rolls-back` |
| SC7 docs-only merge deploys nothing | `R7-docs-only-merge-deploys-nothing` |
| SC8 `shukka deploy` from a laptop: same commit, guard, rollback | `R8-cli-*` (four cases) |
| SC9 shukka's CI green; all throwaway resources deleted | `R10-shukka-ci-green-on-rc`, `SC9-no-throwaway-resources-left`, `SC9-hosted-zone-deleted-within-run` |

### Observations ("trust is observed, not reasoned")

The probes print `RESULT <id> <verdict>` in the GitHub run logs; the suite fetches the logs and
repeats each line in its own log as `RESULT <id> DENIED (run N: ...)`. A missing line is `MISSING`
and fails the case, so a probe that never ran cannot pass. The synth probes are read only from the
synth job's own lines (`pull request / synth`, `stacks / synth`), and must say `NO-TOKEN` (OIDC and
GitHub token) and `NO-CREDS` (AWS). A job without `id-token: write` has no token endpoint at all;
`assume.sh` reports that as `DENIED`.

**What moved to the admin side (shu-9bj.3).** Since shu-9zr no project code runs while the infra
role, the project's CDK deploy role or the diff role is held, so no probe the suite plants in the
consumer can hold them (the old controls `R3-pipeline-ctl-project-deploy-role` and
`R4-prdiff-ctl-get-template`, observed from inside the CDK app, could no longer be met). A consumer
workflow cannot hold them either: calling shukka's infra.yml runs shukka's code, not the probe's, and
a consumer job that asks with its own OIDC token is refused by `job_workflow_ref` (observed in the
R2 cases above, for shukka's roles and the CDK deploy and lookup roles). So what an infra-role,
deploy-role or diff-role session may do is read from IAM with the admin profile:
`aws iam simulate-principal-policy` evaluates the role's identity policies and its permissions
boundary for one action on one resource, with `aws:RequestedRegion`, the resource's real
`Project` tag and, for CloudFormation, `cloudformation:RoleArn` as context. The suite prints
`RESULT <id> <verdict> (simulator: ...)`. Each set keeps a control with the same action and context
shape that must be `ALLOWED` (`R3-pipeline-ctl-project-deploy-role`,
`R3-pipeline-deployrole-ctl-own-stack-changeset`, `R4-prdiff-ctl-get-template`), so a wrong ARN or
a missing context key cannot pass as a refusal. The simulator does not evaluate resource policies,
SCPs or the target role's trust policy; for a refusal a caller-side denial is enough, and the
controls' real counterparts are the pipeline's own deploys (`R1-merge-deploys-full-chain`). The
fence itself (the execution role) is still observed end to end (`R3-execution-role-refuses-other-project`).

### Texts matched in job logs

Matched case-sensitively, anchored at the start of a line the step itself printed (GitHub's indented
`env:`/`with:` dump lines and a leading `##[error]` are handled), and only in the named job. Agreed
with shu-9zr on its mailbox; the guard's lines are `scripts/guard.mjs`'s report.

| Where | Line |
|---|---|
| infra deploy job, planted executable asset | `assembly: <manifest>: file asset shukkatestplantedasset is built by running a command (source.executable); refused` (`scripts/assembly.mjs check`) |
| infra deploy job, destructive diff | `guard: these changes delete or replace a resource:`, then the offending diff lines (must name `AWS::DynamoDB::Table` and `Items`), then `guard: stopping. If this is intended, run the workflow by hand on main with allow_replacement ticked.` |
| smoke job, smoke command failed | a line beginning `shukka: the site is live but failing its smoke test` |
| `shukka deploy`, destructive diff | the same guard header and offending lines |

## Points the suite had to read into the contracts

Kept in one place each so they are easy to correct; all asked on the owners' mailboxes:

- CLI flags (`lib/cli.sh`): `bootstrap <project> --config
  --hosted-zone-id --repo`, `deploy --profile`. The bootstrap stacks are `CDKToolkit-shukkatest` (no
  `Qualifier` parameter) and `Shukka-Boundary-shukkatest`, as `lib/bootstrap.ts` names them
  (`BOOTSTRAP_STACK`, `BOUNDARY_STACK` in `lib/common.sh`); teardown deletes the first (emptying its
  retained assets bucket) before the second.
- Job display names (`JOB_RE_*` in `lib/common.sh`), as shu-9zr named them: `plan`, `check <name>`,
  `build <app>`, `stacks / synth|changes|deploy`, `pull request / synth|diff|comment`,
  `servers / changes|release <app>`, `smoke` (each prefixed `shukka / ` by the caller's job id).
- infra.yml's mode input name (`SHUKKATEST_INFRA_MODE_INPUT`, default `mode`) for calling it directly.
- `build.bundle` is read as a script path relative to `build.dir`.
- The throwaway zone's domain (`SHUKKATEST_ZONE_DOMAIN`, default `shukkatest-<run>.com`, not delegated).
- The consumer's GitHub OIDC subject (`SHUKKATEST_GITHUB_REPO_SUBJECT`, default the immutable form
  `owner@id/repo@id` that spike S1 observed for this repository).
