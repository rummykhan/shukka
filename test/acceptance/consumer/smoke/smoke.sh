#!/usr/bin/env bash
# shukkatest smoke test, run by shukka against the live address after the app deploy.
# Finds the box through its DNS record, then checks both apps answer and the web page carries its
# marker. Changing apps/web/page.txt so the marker is gone makes this fail while /health still passes.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck disable=SC1091 # rendered at run time
source "$here/smoke.env"
name="box.$ZONE"
if command -v dig >/dev/null 2>&1; then
  ip=$(dig +short @"$NS" "$name" A | tail -n 1)
else
  ip=$(nslookup "$name" "$NS" | awk '/^Address: / {a=$2} END {print a}')
fi
[[ -n "$ip" ]] || { echo "smoke: $name has no A record at $NS"; exit 1; }
echo "smoke: $name is $ip"
curl -fsS --max-time 10 --retry 3 --retry-all-errors "http://$ip:8080/health"
curl -fsS --max-time 10 --retry 3 --retry-all-errors "http://$ip:8081/health"
page=$(curl -fsS --max-time 10 "http://$ip:8080/")
if ! grep -q 'shukkatest-web-ok' <<<"$page"; then
  echo "smoke: the web page has lost its marker:"
  printf '%s\n' "$page"
  exit 1
fi
echo "smoke: ok"
