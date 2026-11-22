#!/usr/bin/env bash
# Builds the api bundle into dist/.
set -euo pipefail
cd "$(dirname "$0")"
rm -rf dist
mkdir dist
cp server.py health.json page.txt dist/
: >dist/greeting.txt
