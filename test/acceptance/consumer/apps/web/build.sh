#!/usr/bin/env bash
# Builds the web bundle into dist/. SHUKKATEST_GREETING is a buildEnv value (a repository variable).
#
# Before building it plays a compromised build dependency: it tries to obtain each shukkatest deploy
# role from this job and prints "RESULT R2-build-job-<role> ..." (must be DENIED; R2, closes trn-a2r).
set -euo pipefail
cd "$(dirname "$0")"
bash ../../probe/assume.sh R2-build-job || true
rm -rf dist
mkdir dist
cp server.py health.json page.txt dist/
# A planted hook at the configure hook's path inside the bundle. shukka must never run it: the hook it
# runs comes from the git checkout (uploaded to S3, --configure-key). If it ever runs, it leaves a mark.
mkdir -p dist/box
cp ../../probe/planted-configure.sh dist/box/configure.sh
printf '%s\n' "${SHUKKATEST_GREETING:-}" >dist/greeting.txt
