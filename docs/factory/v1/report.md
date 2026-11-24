---
status: approved
---
# shukka v1: report

**Outcome:** shipped as v1.0.0 (validated as rc.9 at bfb0f17 plus doc commits).

## Evidence
- Gate on the epic branch: 521/521 tests, lint, typecheck, actionlint, shellcheck.
- Every task's acceptance command passes (`koujou accept --parent shu-9bj`).
- Live acceptance suite (`test/acceptance/run.sh v1.0.0-rc.9`, real GitHub and AWS, throwaway `shukkatest*`): 46/49 passed, teardown clean. The 3 not passed were environment, not shukka: an npm `ECONNRESET` in one CLI deploy, and two self-test timeouts while the laptop slept (the same suite passes 521/521 awake). R4 step-summary headings are a manual check.
- shukka's own CI green on PR #1.

## What the live runs found (fixed)
Annotated tags not startable by GitHub (releases are lightweight); launch templates untagged on create and name collisions across projects (`tagProject`); the CI stack could not be deployed through the fence, and its hand deploy ran merged code with admin credentials (`shukka deploy-ci`, with asset destinations pinned); runner shellcheck drift; and a dozen acceptance-suite defects.

## Time
`koujou times shu-9bj`: 42h23m first claim to last landing, 135 agents. Most of the overrun was the in-loop security review (lens agents running 12–16 h each, then a serial fix loop; shu-9bj.8 alone took 13 h). After the factory change on 2026-11-22 (security review on demand, time boxes), the 10 fix tasks that followed took 8–26 minutes each with 1–2 agents apiece; the remaining wall clock was the live acceptance runs (about 1.5–2 h each, nine release candidates).

## Deferred
shu-8az, shu-6bb, shu-9w5, shu-bca, shu-2vm, shu-njm, shu-04k, shu-dj1, shu-s8t, shu-ww3, and the follow-ups filed during the live runs (`bd list --label factory:deferred`).

## Waiting on you
Nothing for shukka. The Trendigle switch-over (shu-li0) follows.
