# Spike S1: OIDC claims from nested reusable workflows (2026-11-22)

Setup: public `rummykhan/shukka` branch `spike-s1` with `spike-entry.yml` (reusable) nesting `spike-inner.yml` two ways (`./` path and full `owner/repo/...@ref`); private caller `rummykhan/shukka-consumer-test` on `main`, push event. Three throwaway roles in the shared account (deleted afterwards). Run 44993644773.

Observed:
- `job_workflow_ref` in the inner job is the **innermost** reusable workflow: `rummykhan/shukka/.github/workflows/spike-inner.yml@refs/heads/spike-s1`. No owner or repo IDs in it, even though both repositories use immutable subjects.
- `sub` stays the caller's: `repo:rummykhan@12664104/shukka-consumer-test@1467277665:ref:refs/heads/main`.
- `uses: ./.github/workflows/x.yml` inside a reusable workflow resolves to **shukka at the same ref**, identical claims to the full reference. So nested calls do not need their version written in.
- IAM accepts `token.actions.githubusercontent.com:job_workflow_ref` as a condition key and **evaluates it**: a role requiring `.../spike-inner.yml@*` was assumed; the same role requiring `.../other.yml@*` was refused (`AccessDenied`).
- IAM rejects a trust policy whose `sub`/`job_workflow_ref` pattern starts with `*` ("not scoped to all"); patterns must start with the literal owner.
- A job without `id-token: write` has no token request URL at all.

Consequences for the design:
- D3 holds as designed, using `job_workflow_ref` as a separate condition. **No subject template customisation is needed** (prerequisite P7 not used; Trendigle's OIDC settings stay as they are).
- Trust pattern for roles: `rummykhan/shukka/.github/workflows/<file>.yml@refs/tags/v1*` (tag refs), plus `sub` = `repo:<caller-subject-repo>:ref:refs/heads/main` (or `:pull_request` for the diff role, to be observed in acceptance).
- New rule from thinking about the result: the configure hook that runs as root on the server must come from the repository checkout in `ec2.yml`, not from the build artifact, or a compromised build dependency could plant root code. Added to the design.
