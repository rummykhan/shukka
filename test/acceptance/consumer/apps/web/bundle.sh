#!/usr/bin/env bash
# shukka's bundle hook: prints the directory to tar (built by build.sh).
set -euo pipefail
cd "$(dirname "$0")"
[[ -f dist/server.py ]] || { echo "bundle: dist/ is not built" >&2; exit 1; }
printf '%s\n' "$PWD/dist"
