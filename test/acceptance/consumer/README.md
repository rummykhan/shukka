# shukka-consumer-test

Throwaway consumer of [shukka](https://github.com/rummykhan/shukka), rewritten by shukka's acceptance
suite (`test/acceptance/run.sh` in shukka) on every run. Do not edit by hand: the next run replaces
everything here.

- `.github/workflows/ci.yml` is the whole CI file: the caller of `pipeline.yml` at a release candidate.
- `shukka.json` is the project's settings.
- `infra/` is a CDK app for the throwaway project `shukkatest`: an instance with an elastic IP,
  security group, launch template, role and profile, a table, the deploy bucket and a DNS record in a
  throwaway hosted zone; and the Ci stack with `ShukkaAccess`.
- `apps/web` and `apps/api` are two tiny Python servers with `/health`; `apps/web/health.json` set to
  `{"healthy": false}` makes a release unhealthy.
- `probe/` holds the scripts that try to obtain credentials they must not get.

Docs-only edits to this file are how the suite proves a docs-only merge deploys nothing.
