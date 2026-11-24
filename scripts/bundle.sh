#!/usr/bin/env bash
# bundle.sh: turn a Next.js standalone build into a directory upload.mjs can ship.
# Run in the app's build dir (shukka.json apps[].build.bundle) after `next build` with
# `output: 'standalone'`.
#
# usage: bundle.sh [build-dir]          (default: the current directory)
#
# Copies .next/standalone to .next/shukka-bundle, adds .next/static and public (which Next.js leaves
# out of standalone output), and deletes every .env* file: local settings must never reach the server.
# Prints the bundle's absolute path as the only line on stdout; messages go to stderr.
set -euo pipefail

fail() {
  printf 'bundle.sh: %s\n' "$*" >&2
  exit 1
}

[ $# -le 1 ] || fail "usage: bundle.sh [build-dir]"
build_arg=${1:-.}
[ -d "$build_arg" ] || fail "$build_arg is not a directory"
build=$(cd -- "$build_arg" && pwd -P)
standalone=$build/.next/standalone
static=$build/.next/static
out=$build/.next/shukka-bundle

[ -f "$standalone/server.js" ] || fail "no $standalone/server.js: build with output: 'standalone' in next.config first"
[ -d "$static" ] || fail "no $static: run next build first"

rm -rf -- "$out"
cp -a -- "$standalone" "$out"
mkdir -p -- "$out/.next"
rm -rf -- "$out/.next/static"
cp -a -- "$static" "$out/.next/static"
if [ -d "$build/public" ]; then
  rm -rf -- "$out/public"
  cp -a -- "$build/public" "$out/public"
fi
find "$out" -name '.env*' -prune -exec rm -rf -- {} +

printf '%s\n' "$out"
