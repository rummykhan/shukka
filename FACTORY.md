# Factory profile

## Project

shukka (出荷, "shipping out") is a reusable deployment pipeline for AWS CDK projects on GitHub Actions: reusable workflows, CDK constructs (deploy roles, per-project fence, account stack), Node scripts shared by the workflows and a CLI, and a release script that runs on EC2 servers through SSM. Public repository `rummykhan/shukka`, MIT. Users are the owner's projects (first Trendigle, `trendigle/trendigle`, at `/Users/rehan/Documents/Workspace/postiz/scheduler`; later Orbitary) and anyone who finds it. Greenfield: on 2026-11-22 the repo holds only the approved v1 requirements and design (`docs/factory/v1/`) and two spikes.

Layout (as designed; created by the first tasks): `.github/workflows/` (pipeline.yml, infra.yml, ec2.yml, plus shukka's own `test.yml`), `lib/` (TypeScript constructs), `scripts/` (Node 22 ES modules), `bin/shukka` (CLI), `box/` (server scripts), `schema/` (shukka.json schema), `test/`.

## Commands

Run from the repo root.

| Purpose | Command |
|---|---|
| Install | `npm ci` (Node 22) |
| Local services | Docker, for the release-script tests only (`docker info` must work) |
| Gate | `npm run gate` = `npm run lint && npm run typecheck && npm test && npm run actionlint && npm run shellcheck`; shellcheck runs via `find box scripts -name '*.sh' -type f -exec shellcheck {} +`; typecheck covers `lib/`, `test/` and `scripts/**/*.mjs` (JSDoc types, `checkJs`) |
| Run locally | `node bin/shukka --help`; workflows only run on GitHub |
| Worktree setup | `npm ci`. Nothing is shared between worktrees except Docker; container names in tests carry the worktree's task id |
| Deploy | Tag a release (`vX.Y.Z` and move `v1`) after CI is green on main, always as a **lightweight** tag (`git tag v1.2.3 <sha>`, `git tag -f v1 <sha>`; never `-a`/`-m`): GitHub will not start a caller pinned to an annotated tag (shu-9bj.16). Consumers pick it up by pin |
| Watch a deploy | `gh run list -R rummykhan/shukka`; consumers: `gh run list -R trendigle/trendigle` |
| Post-deploy smoke | The consumer's own CI run after bumping its pin |

Known gaps in the gate: anything that needs a real GitHub token or AWS (trust rules, the fence, the pipeline end to end) is only provable in acceptance, against `rummykhan/shukka-consumer-test` and throwaway `shukkatest*` resources.

## Baseline

2026-11-22, `e21bf3a`: no code; nothing to run. The first task makes the gate exist and green.

## Git policy

- Base branch: `main`
- Epic branch: `factory/<epic-id>`; task branches: `factory-task/<task-id>`
- Commits: one plain-English sentence; no bead id. Commit identity is the GitHub noreply address (repo-local config), as in koujou. Factory builders commit on their own task branch; this overrides the "do not commit unless asked" text beads wrote into AGENTS.md and CLAUDE.md.
- Push: the epic branch when shipping; acceptance may also push release-candidate tags (`v1.0.0-rc.N`) from the epic branch so the test consumer can call them. Task branches are never pushed. Never push `main` directly.
- Integration: pull request to `main`, opened by the factory.
- Merge: factory, after the owner approves each time; method: merge.
- Required human review: the owner.

## Deploy policy

- Environments: none of its own. What it changes is consumers' AWS: the shared account `818221194501` (profile `stelking`, us-east-1) holding Trendigle and Orbitary.
- Validation target: Docker containers (release script), `rummykhan/shukka-consumer-test` (private) calling a release-candidate tag, and throwaway resources named `shukkatest*` in the shared account, deleted at the end.
- Production changes: Trendigle's switch-over (account stack, Trendigle bootstrap, Ci stack, first merge through shukka) are made by the factory with the owner's leave given on 2026-11-22 (prerequisites P3, P4, P6, P8, P9 in `docs/factory/v1/requirements.md`), one step at a time, diff shown first, in a quiet moment. Anything else in that account: owner only.
- Rollback: for shukka, consumers pin the previous tag. For Trendigle's switch-over, see the design's Rollout section.

## Validation

Exercise shukka as a consumer would: the test consumer repository's CI runs, `bin/shukka` from a laptop, and the release script in containers.
Never use: Orbitary's resources (look, never touch), Trendigle's production data, any AWS action outside `shukkatest*` names except the switch-over steps the owner approved.

## Test map

| Module | Exercise it through | Its state lives in | Cross-check, read-only | Access |
|---|---|---|---|---|
| Workflows (`.github/workflows/`) | Test consumer CI calling an rc tag | GitHub run logs | `gh run view -R rummykhan/shukka-consumer-test --log` | local: actionlint. GitHub: `gh` as the owner |
| Constructs (`lib/`) | Unit tests on synthesized templates; `cdk diff/deploy` of `shukkatest` stacks | CloudFormation | `aws cloudformation describe-stacks`, `aws iam get-role(-policy)` | profile `stelking`, read for checks; writes only on `shukkatest*` |
| Fence policies | Simulator cases (`docs/factory/v1/spikes/s2/simulate.py`) and real refusals in acceptance | IAM | `aws iam simulate-custom-policy`, `get-policy-version` | `stelking` |
| Scripts and CLI (`scripts/`, `bin/`) | `node --test`; CLI against `shukkatest` | none | output | local |
| Release script (`box/`) | Docker container with two fake apps | files under `/opt` in the container | `docker exec … cat …/REVISION` | local Docker |
| Trendigle switch-over | Trendigle PR and merge | Trendigle stacks, server `/opt/trendigle` | `gh run view -R trendigle/trendigle`, `aws ssm send-command` read-only `cat`, `curl https://trendigle.com` | `stelking` |

## QA

- Acceptance suite: `test/acceptance/` (shell + `gh` + `aws`), run by hand against the test consumer: `bash test/acceptance/run.sh <rc-tag>`. Not in the gate (needs GitHub and AWS).
- One task's tests: `node --test --test-name-pattern "<id>"` (tests are named with the task id); release-script tests: `bash test/box/run.sh <id>`.
- Browser testing: none (no UI).
- Test accounts: the owner's `gh` login and the `stelking` profile on this machine; nothing in files.
- Evidence: `docs/factory/v1/evidence/`

## Security review

- Lenses: `access`, `input`, `exposure`, all three on every epic.
- Extra lens, folded into `access`: **escalation**. Can anything in a consumer's build, a pull request, a fork of shukka, or a tag reach AWS credentials, the infrastructure role, another project's resources, or root on a server? Is every trust policy pinned to repo, branch or event, and workflow file?
- Trust boundaries: shukka is public and anyone can read and fork it; only the owner can push or tag. Consumers trust a shukka tag with their AWS account. Pull requests in consumer repos are untrusted code.
- Out of bounds: Orbitary's and Trendigle's live resources (read only); security agents work on synthesized templates, the simulator, containers and `shukkatest*` only.

## Prerequisites and secrets

- Where secrets go: nowhere. shukka holds none; consumers use OIDC. The repo is public: a secret scan runs in its CI.
- Already available: `gh` as `rummykhan` (admin on `rummykhan/shukka`, `rummykhan/shukka-consumer-test`, `trendigle/trendigle`); AWS profile `stelking` (admin, account `818221194501`).
- Sandbox vs real: `shukkatest*` throwaway resources in the shared account; a throwaway hosted zone must be deleted within 12 hours (free).

## Docs map

| Artifact | Location |
|---|---|
| Work orders | `docs/factory/<slug>/` |
| Requirements | `<work order>/requirements.md` |
| Design | `<work order>/design.md` |
| Spikes | `<work order>/spikes/` |
| Decision log | the Decisions table in each design |
| Pitfalls / lessons | `## Lessons` below |

## Beads

- Prefix: `shu`; sync: local only.
- The origin epic is `trn-zl4` in Trendigle's tracker; shukka's own tracker holds the build.

## Limits

- `max_fix_attempts`: 3
- `max_fix_depth`: 3
- `max_rebases`: 3
- `max_parallel_builders`: 3
- Worktree root: `../.factory-worktrees/shukka`

## Lessons

<!-- One line each, dated, with the bead id that taught it. Written by factory-retro; read by every worker before starting. -->
- 2026-11-22 (spike S1): AWS evaluates `token.actions.githubusercontent.com:job_workflow_ref`; it names the innermost reusable workflow; patterns must not start with `*`.
- 2026-11-22 (spike S2): a managed policy is at most 6,144 characters; the fence is a name prefix, so project names must not prefix each other.

## Open questions

None (policies above confirmed by the owner's approvals on 2026-11-22).

## Project rules

Read before touching code: this file, AGENTS.md, `docs/factory/v1/design.md` (the contracts are binding). Hard rules: nothing secret in the repo; every IAM statement has a resource narrower than `*` unless the action has no resource type, and says why in a comment; workflow files never interpolate `${{ }}` expressions from inputs or events directly into `run:` (use `env:`).
