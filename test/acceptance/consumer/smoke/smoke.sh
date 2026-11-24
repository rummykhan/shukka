#!/usr/bin/env bash
# shukkatest smoke test, run by shukka against the live address after the app deploy.
# Finds the box through its DNS record, then checks both apps answer and the web page carries its
# marker. Changing apps/web/page.txt so the marker is gone makes this fail while /health still passes.
# The zone is not delegated, so the record is asked of the zone's name server directly, with Node's
# resolver: dig and nslookup are not in shukka's CLI image (node:22) and getent only asks the system
# resolver (shu-9bj.22). NS may be a host name or an address (address:port too).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck disable=SC1091 # rendered at run time
source "$here/smoke.env"
name="box.$ZONE"
# shellcheck disable=SC2016 # the single-quoted text is JavaScript, not shell
ip=$(node -e '
const dns = require("node:dns").promises;
const net = require("node:net");
const [name, ns] = process.argv.slice(1);
(async () => {
  const host = ns.replace(/:\d+$/, "");
  const server = net.isIP(host) ? ns : (await dns.lookup(ns, { family: 4 })).address;
  const r = new dns.Resolver({ timeout: 5000, tries: 3 });
  r.setServers([server]);
  const a = await r.resolve4(name);
  console.log(a[a.length - 1]);
})().catch((e) => { console.error(`smoke: cannot resolve ${name} at ${ns}: ${e.message}`); process.exit(1); });
' "$name" "$NS") || ip=
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
