#!/usr/bin/env bash
# The project's checks: the servers compile and health.json parses. Also a probe: the checks job must
# not be able to obtain a deploy role either ("RESULT R2-checks-job-<role> ...", must be DENIED).
set -euo pipefail
cd "$(dirname "$0")/.."
bash probe/assume.sh R2-checks-job || true
for app in web api; do
  python3 -m py_compile "apps/$app/server.py"
  python3 -c 'import json, sys; json.load(open(sys.argv[1]))' "apps/$app/health.json"
done
echo "checks: ok"
