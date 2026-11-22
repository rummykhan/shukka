---
status: approved
lane: L
---
# shukka: reusable deployment pipeline (GitHub Actions + CDK)

## Problem

Trendigle now deploys infrastructure and app from GitHub Actions (trn-b04, PR #27), but the pipeline lives inside Trendigle and has known weaknesses: the app-build job can reach the infrastructure role (trn-a2r), the CDK execution role is administrator of an AWS account shared with Orbitary, and a bad server install has no automatic rollback. Orbitary deploys by hand from a laptop. Each future project would copy and drift. The owner wants one pipeline, cheap and safe, that every project pulls in. GitHub Actions is the chosen platform (2026-11-22; CodePipeline ruled out on cost).

## Goals

- A new project goes from "has CDK stacks and a build" to "deploys on merge" by adding configuration, not by writing workflow or IAM code.
- A merge cannot silently delete or replace stateful infrastructure.
- Code that builds the application cannot obtain infrastructure credentials, and one project's pipeline cannot change another project's resources.
- A failed server deploy leaves the previous version serving.
- Running costs stay inside free allowances at our volume.
- Trendigle deploys through it now; Orbitary and later projects adopt it with configuration only. Changes reach a project by bumping a version.

## Non-goals

- AWS CodePipeline, CodeBuild, or any paid CI service.
- ECS and Lambda deploy adapters (designed for, built when a project needs one).
- Several environments per project (staging); one `prod` per project, with the shape allowing more later.
- Moving Trendigle's or Orbitary's servers to a different kind of compute.
- Branch protection or paid GitHub features (the pipeline must be safe without them, and use them when present).
- Building or testing the projects' code beyond calling each project's own commands.
- Adopting it in Orbitary (owner, 2026-11-22: Trendigle only this delivery). The design must still fit Orbitary's shape: one server running several apps, a different GitHub organisation, the same AWS account.

## Requirements

### R1 — One reusable workflow, called from each project
A project's whole CI file is a short caller that names the shared workflow at a version and passes settings (commands, paths, stack names, role ARNs as variables).
Acceptance:
- Given a project with CDK stacks and build and test commands, when its caller workflow is the only CI file, then pull requests run the checks and merges to `main` run checks, infrastructure deploy, app deploy and smoke.
- Given the shared workflow publishes v1.1, when a project still pins v1.0, then nothing changes for it until it bumps.

### R2 — A CDK construct creates the project's deploy access
One construct, added to a project's CI stack, creates the GitHub OIDC provider (or reuses the account's), the infrastructure role and the app-deploy role, with trust limited to that repository, the `main` branch, and the shared workflow's own job.
Acceptance:
- Given a workflow run on any branch other than `main`, a pull request, or a tag, when it asks for either role, then AWS refuses.
- Given a step in the job that builds or tests application code, when it asks for the infrastructure role, then AWS refuses (closes trn-a2r).
- Given the account already has a GitHub OIDC provider, when a second project adds the construct, then deploy succeeds without creating a duplicate.

### R3 — Projects are fenced from each other
Each project's infrastructure deploy runs with an execution role (or permissions boundary) limited to that project's own resources, not account administrator.
Acceptance:
- Given Trendigle's pipeline credentials, when they try to change another project's stack, table or bucket (a throwaway stack standing in for Orbitary), then AWS refuses.
- Given Trendigle's pipeline, when it deploys its own four stacks, then it succeeds.

### R4 — Destructive changes stop for a person
Before deploying, the pipeline shows the full infrastructure diff in the run summary. If anything would be deleted or replaced, or the diff is incomplete, the run stops. A person can rerun with an explicit "allow" to proceed. Stateful resources (tables, buckets, DNS zones) are retained by default in the construct.
Acceptance:
- Given a diff that removes or replaces a resource, when a merge runs, then nothing is deployed and the run says which resources and how to proceed.
- Given the same change, when rerun by hand with allow ticked, then it deploys.
- Given a pull request that changes infrastructure, when its checks run, then the diff is shown on the pull request without the pull request's code receiving credentials that can change anything.

### R5 — App deploy to a single EC2 server, with rollback
The EC2 adapter builds the app on the runner, uploads a versioned bundle, installs it through SSM Run Command, runs the project's health check on the server, and rolls back to the previous bundle if the check fails. It keeps the last N bundles.
Acceptance:
- Given an install whose health check fails, when the deploy runs, then the previous version is serving again, the run is red, and the log shows both versions.
- Given a successful deploy, when the server is asked which version it runs, then it reports the commit that was merged.
- Given two merges in quick succession, when both deploy, then they run one after the other and the later commit ends up live.
- Given a server running several apps, when one app is deployed, then the others keep running (tested on a fixture with two apps; Orbitary itself is next pass).

### R6 — Smoke test after deploy
After the app deploy, the project's smoke command runs against the live address; a failure turns the run red.
Acceptance:
- Given the smoke command fails, when the run ends, then it is red and says the site is live but failing its smoke test.

### R7 — Cheap by default
Unchanged parts are skipped, dependencies are cached, jobs that do not need isolation share a runner.
Acceptance:
- Given Trendigle's current merge rate, when a month is measured, then runner minutes stay inside the Free plan's allowance.
- Given a merge that changes only docs, when CI runs, then no deploy job runs.

### R8 — Emergency deploy without GitHub
A documented command deploys the same way from a laptop with short-lived credentials, for when GitHub is down.
Acceptance:
- Given GitHub Actions is unavailable, when the owner follows the README, then the same commit is deployed with the same guard and health check.

### R9 — Trendigle uses it
Acceptance:
- Given Trendigle switches to shukka, when the next merge deploys, then the CDK diff is empty except for the role changes this epic makes, the app is live and smoke passes.
- Given Trendigle's caller workflow, when it is read, then it contains settings only: no deploy steps, no IAM.

### R10 — Contributors can trust a change to the pipeline
The pipeline repository has its own tests that run in its CI: the guard against real `cdk diff` samples, the construct's synthesized trust policies, and the workflow files linted.
Acceptance:
- Given a change that loosens a trust policy or breaks the guard, when its pull request runs, then a test fails.

## Constraints

- Public repository (required: Trendigle and Orbitary are in different GitHub organisations, and GitHub shares private reusable workflows only within one organisation). Nothing secret may live in it.
- No stored AWS keys anywhere; GitHub OIDC only.
- No inbound ports opened; servers are reached through SSM only.
- Must work on GitHub Free for private consumer repositories.
- Node 22 and the CDK version range the projects already use.
- Must not change any production resource beyond the deploy roles without the guard showing it.

## Assumptions

- Repository `rummykhan/shukka`, public, MIT, commits with the GitHub noreply identity like koujou.
- The workflow is referenced by git tag (`rummykhan/shukka/.github/workflows/deploy.yml@v1`). The construct is installed from the same tag as a git dependency, so no npm account is needed; publishing to npm is optional and later (this machine is not signed in to npm).
- "Merge to main is the approval" remains the production gate on Free.
- Health check is an HTTP URL on the server that each project names.
- Bundles kept: last 5.

## Prerequisites

| # | What | Needed by | Why | Status | If unavailable |
|---|---|---|---|---|---|
| P1 | Repository name, owner and package name | all | Public home | provided: rummykhan/shukka (2026-11-22) | — |
| P2 | Leave to create the public repository rummykhan/shukka and push to it | R1, R2 | Projects pull from it | provided by the owner's choice of home (2026-11-22); confirmed before the first push | — |
| P3 | Leave to deploy Trendigle's Ci stack by hand once when its roles change (as on 2026-11-22) | R2, R3 | A pipeline cannot create the role it runs as | provided (2026-11-22) | — |
| P4 | Leave to change Trendigle's CDK bootstrap: a new, limited execution role for its deploys | R3 | The fence | provided (2026-11-22) | — |
| P5 | Leave to create and delete a throwaway stack in the shared account to prove the fence | R3 | Prove the fence | provided (2026-11-22) | — |
| P6 | Leave to create a private test repository `rummykhan/shukka-consumer-test` and throwaway roles and stacks (`shukkatest-*`) in the shared account, all deleted at the end | R1, R2, R4, S1 | Prove the trust rules with real GitHub tokens before touching Trendigle | pending (added by design) | Trust rules proven only on Trendigle's switch-over merge |
| P7 | Leave to change Trendigle's GitHub OIDC subject template (`include_claim_keys`), which changes the subject for every workflow in that repo | R2 | Workflow-scoped trust | pending (added by design) | Trust by `job_workflow_ref` condition alone, if spike S1 shows AWS accepts it |
| P8 | Leave for one deliberately unhealthy release of Trendigle's admin panel in a quiet moment, to see the rollback on the real box | R5 | Rollback observed, not only in a container | pending (added by design) | Rollback observed in the container and the test consumer only |
| P9 | `LEGAL_ENTITY` and `CONTACT_EMAIL` copied from Parameter Store to Trendigle's GitHub repository variables | R9 | Build without credentials (D9) | pending (added by design) | The factory copies them with leave; they are public page text |

## Open questions

None.
