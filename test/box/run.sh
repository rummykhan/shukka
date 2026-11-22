#!/usr/bin/env bash
# Tests for box/shukka-release.sh in Docker containers (Amazon Linux 2023, fake systemctl, fake aws).
# usage: bash test/box/run.sh [pattern]   runs the cases whose names contain <pattern> (all if empty)
# Each case gets a fresh container. Containers and the image carry the pattern in their names so
# parallel runs never collide, and are removed on exit.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
pattern=${1:-}
tag=$(printf '%s' "${pattern:-all}" | tr -c 'a-zA-Z0-9-' '-' | tr '[:upper:]' '[:lower:]')
image="shukka-box-test:$tag-$$"
prefix="shukka-box-$tag-$$"
work=$(mktemp -d)
containers=()

cleanup() {
  local c
  for c in "${containers[@]+"${containers[@]}"}"; do docker rm -f "$c" >/dev/null 2>&1; done
  docker rmi -f "$image" >/dev/null 2>&1
  rm -rf "$work"
}
trap cleanup EXIT

docker build -q -t "$image" "$here" >/dev/null || { echo "docker build failed"; exit 1; }

BUCKET=shukka-test-bucket
SECRET=fixture-secret-shu766-must-not-print
BOX=
OUT=
RC=
failed=0

# --init: an init that reaps stopped app processes, as systemd would (zombies look alive to kill -0).
new_box() {
  BOX="$prefix-${#containers[@]}"
  docker run -d --init --name "$BOX" -v "$repo/box:/shukka/box:ro" "$image" sleep infinity >/dev/null || return 1
  containers+=("$BOX")
}
x() { docker exec "$BOX" bash -c "$1"; }
bundle() { x "/fixtures/make-bundle.sh $BUCKET $*"; } # project app sha port variant [sleep]

# release <app> <sha> <port> [extra args]: runs the release script as the SSM agent would (root).
release_args() {
  local app=$1 sha=$2 port=$3
  echo --project demo --app "$app" --sha "$sha" --bucket "$BUCKET" --region us-east-1 \
    --configure-key "demo/$app/$sha.configure.sh" --units "demo-$app" --health "http://127.0.0.1:$port/health" \
    --health-timeout 6
}
release() {
  local app=$1 sha=$2 port=$3; shift 3
  # shellcheck disable=SC2046
  OUT=$(docker exec "$BOX" bash /shukka/box/shukka-release.sh $(release_args "$app" "$sha" "$port") "$@" 2>&1)
  RC=$?
}
last_line() { printf '%s\n' "$OUT" | tail -n 1; }

fail() { echo "    FAIL: $*"; case_failed=1; }
expect_eq() { [ "$2" = "$3" ] || fail "$1: expected [$3], got [$2]"; }
expect_rc() { [ "$RC" = "$1" ] || { fail "exit code: expected $1, got $RC"; printf '%s\n' "$OUT" | sed 's/^/      | /'; }; }
expect_last() { expect_eq "last line" "$(last_line)" "$1"; }
served() { x "curl -s -m 2 http://127.0.0.1:$1/version"; }
health_code() { x "curl -s -o /dev/null -w '%{http_code}' -m 2 http://127.0.0.1:$1/health"; }
link() { x "readlink /opt/demo/$1/$2"; }
unit_pid() { x "cat /run/fake-systemd/demo-$1.pid"; }

# ---------------------------------------------------------------------------------------------

case_success() {
  bundle demo web aaaaaaa 8101 good
  bundle demo web bbbbbbb 8101 good
  release web aaaaaaa 8101
  expect_rc 0
  expect_last "shukka: demo/web none -> aaaaaaa live"
  expect_eq "current" "$(link web current)" "/opt/demo/web/releases/aaaaaaa"
  expect_eq "REVISION" "$(x 'cat /opt/demo/web/current/REVISION')" "aaaaaaa"
  expect_eq "served" "$(served 8101)" "aaaaaaa"
  expect_eq "hook env" "$(x 'tail -n 1 /var/log/hook-env.log')" \
    "hook: PROJECT=demo APP=web SHA=aaaaaaa REGION=us-east-1 dir=/opt/demo/web/releases/aaaaaaa"
  case $(x 'tail -n 1 /var/log/fake-aws.log') in
    "aws s3 cp s3://$BUCKET/demo/web/aaaaaaa.tgz "*" --region us-east-1"*) ;;
    *) fail "download call: $(x 'tail -n 1 /var/log/fake-aws.log')" ;;
  esac
  release web bbbbbbb 8101
  expect_rc 0
  expect_last "shukka: demo/web aaaaaaa -> bbbbbbb live"
  expect_eq "current" "$(link web current)" "/opt/demo/web/releases/bbbbbbb"
  expect_eq "previous" "$(link web previous)" "/opt/demo/web/releases/aaaaaaa"
  expect_eq "served" "$(served 8101)" "bbbbbbb"
  expect_eq "unit state" "$(x 'systemctl is-active demo-web')" "active"
}

case_download_failed() {
  bundle demo web aaaaaaa 8101 good
  release web aaaaaaa 8101
  expect_rc 0
  release web ccccccc 8101
  expect_rc 10
  expect_last "shukka: demo/web aaaaaaa -> ccccccc download-failed"
  x "mkdir -p /fake-s3/$BUCKET/demo/web && echo not-a-tarball >/fake-s3/$BUCKET/demo/web/ddddddd.tgz"
  release web ddddddd 8101
  expect_rc 10
  expect_last "shukka: demo/web aaaaaaa -> ddddddd download-failed"
  bundle demo web eeeeeee 8101 good
  x "rm /fake-s3/$BUCKET/demo/web/eeeeeee.configure.sh"
  release web eeeeeee 8101
  expect_rc 10
  expect_last "shukka: demo/web aaaaaaa -> eeeeeee download-failed"
  expect_eq "current" "$(link web current)" "/opt/demo/web/releases/aaaaaaa"
  expect_eq "releases" "$(x 'ls -A /opt/demo/web/releases | tr "\n" " "')" "aaaaaaa "
  expect_eq "hooks" "$(x 'ls -A /opt/demo/web/hooks | tr "\n" " "')" "aaaaaaa.sh "
  expect_eq "served" "$(served 8101)" "aaaaaaa"
}

case_hook_from_s3_only() {
  bundle demo web aaaaaaa 8101 good
  release web aaaaaaa 8101
  expect_rc 0
  expect_last "shukka: demo/web none -> aaaaaaa live"
  x "test -f /opt/demo/web/releases/aaaaaaa/box/configure.sh" || fail "the bundle did not carry the planted hook"
  x "test ! -e /var/log/bundle-hook-ran" || fail "the hook inside the bundle ran: $(x 'cat /var/log/bundle-hook-ran')"
  expect_eq "S3 hook ran" "$(x 'tail -n 1 /var/log/hook-env.log')" \
    "hook: PROJECT=demo APP=web SHA=aaaaaaa REGION=us-east-1 dir=/opt/demo/web/releases/aaaaaaa"
  expect_eq "hooks/aaaaaaa.sh is the S3 hook" "$(x 'cksum </opt/demo/web/hooks/aaaaaaa.sh')" \
    "$(x "cksum </fake-s3/$BUCKET/demo/web/aaaaaaa.configure.sh")"
  expect_eq "hook file mode" "$(x 'stat -c "%a %U %G" /opt/demo/web/hooks/aaaaaaa.sh')" "700 root root"
  expect_eq "hooks dir mode" "$(x 'stat -c "%a %U %G" /opt/demo/web/hooks')" "700 root root"
}

case_configure_failed() {
  bundle demo web aaaaaaa 8101 good
  bundle demo web bbbbbbb 8101 hookfail
  release web aaaaaaa 8101
  expect_rc 0
  local pid; pid=$(unit_pid web)
  release web bbbbbbb 8101
  expect_rc 11
  expect_last "shukka: demo/web aaaaaaa -> bbbbbbb configure-failed"
  expect_eq "current" "$(link web current)" "/opt/demo/web/releases/aaaaaaa"
  x "test ! -e /opt/demo/web/previous" || fail "previous was switched"
  x "test ! -e /opt/demo/web/releases/bbbbbbb" || fail "failed release was not deleted"
  x "test ! -e /opt/demo/web/hooks/bbbbbbb.sh" || fail "failed release's hook was not deleted"
  expect_eq "releases" "$(x 'ls -A /opt/demo/web/releases | tr "\n" " "')" "aaaaaaa "
  expect_eq "unit not restarted" "$(unit_pid web)" "$pid"
  expect_eq "served" "$(served 8101)" "aaaaaaa"
}

case_rolled_back() {
  bundle demo web aaaaaaa 8101 good
  bundle demo web bbbbbbb 8101 good
  bundle demo web ccccccc 8101 unhealthy
  release web aaaaaaa 8101
  release web bbbbbbb 8101
  expect_rc 0
  local pid; pid=$(unit_pid web)
  release web ccccccc 8101
  expect_rc 12
  expect_last "shukka: demo/web bbbbbbb -> ccccccc rolled-back"
  expect_eq "current" "$(link web current)" "/opt/demo/web/releases/bbbbbbb"
  expect_eq "previous" "$(link web previous)" "/opt/demo/web/releases/aaaaaaa"
  expect_eq "REVISION" "$(x 'cat /opt/demo/web/current/REVISION')" "bbbbbbb"
  x "test ! -e /opt/demo/web/releases/ccccccc" || fail "unhealthy release was not deleted"
  [ "$(unit_pid web)" != "$pid" ] || fail "previous release was not restarted"
  expect_eq "unit state" "$(x 'systemctl is-active demo-web')" "active"
  expect_eq "health" "$(health_code 8101)" "200"
  expect_eq "served" "$(served 8101)" "bbbbbbb"
  printf '%s\n' "$OUT" | grep -q "checking health of bbbbbbb" || fail "rollback health check not reported"
}

case_rollback_unhealthy() {
  bundle demo web aaaaaaa 8101 good
  bundle demo web bbbbbbb 8101 unhealthy
  release web aaaaaaa 8101
  expect_rc 0
  x "rm /opt/demo/web/releases/aaaaaaa/public/health"
  release web bbbbbbb 8101
  expect_rc 13
  expect_last "shukka: demo/web aaaaaaa -> bbbbbbb rollback-unhealthy"
  expect_eq "current" "$(link web current)" "/opt/demo/web/releases/aaaaaaa"
}

case_first_release_unhealthy() {
  bundle demo web aaaaaaa 8101 unhealthy
  release web aaaaaaa 8101
  expect_rc 13
  expect_last "shukka: demo/web none -> aaaaaaa rollback-unhealthy"
}

case_same_app_serialised() {
  bundle demo web aaaaaaa 8101 good 2
  bundle demo web bbbbbbb 8101 good 2
  local a b ra rb
  # shellcheck disable=SC2046
  docker exec "$BOX" bash /shukka/box/shukka-release.sh $(release_args web aaaaaaa 8101) >"$work/a" 2>&1 & a=$!
  sleep 0.3
  # shellcheck disable=SC2046
  docker exec "$BOX" bash /shukka/box/shukka-release.sh $(release_args web bbbbbbb 8101) >"$work/b" 2>&1 & b=$!
  wait "$a"; ra=$?
  wait "$b"; rb=$?
  expect_eq "first exit" "$ra" 0
  expect_eq "second exit" "$rb" 0
  expect_eq "hook order" "$(x "awk '{print \$1, \$3}' /var/log/hook-order.log | tr '\n' ' '")" \
    "start aaaaaaa end aaaaaaa start bbbbbbb end bbbbbbb "
  expect_eq "second last line" "$(tail -n 1 "$work/b")" "shukka: demo/web aaaaaaa -> bbbbbbb live"
  expect_eq "served" "$(served 8101)" "bbbbbbb"
}

case_two_apps_independent() {
  bundle demo web aaaaaaa 8101 good
  bundle demo api 1111111 8102 good
  bundle demo web bbbbbbb 8101 good 5
  bundle demo api 2222222 8102 good
  release web aaaaaaa 8101; expect_rc 0
  release api 1111111 8102; expect_rc 0
  local w rw t0 t1 api_pid
  # shellcheck disable=SC2046
  docker exec "$BOX" bash /shukka/box/shukka-release.sh $(release_args web bbbbbbb 8101) >"$work/w" 2>&1 & w=$!
  sleep 1
  t0=$(date +%s)
  release api 2222222 8102
  t1=$(date +%s)
  expect_rc 0
  expect_last "shukka: demo/api 1111111 -> 2222222 live"
  [ $((t1 - t0)) -lt 4 ] || fail "api release took $((t1 - t0))s: it waited for web"
  kill -0 "$w" 2>/dev/null || fail "web release had already finished, so nothing ran in parallel"
  api_pid=$(unit_pid api)
  wait "$w"; rw=$?
  expect_eq "web exit" "$rw" 0
  expect_eq "web last line" "$(tail -n 1 "$work/w")" "shukka: demo/web aaaaaaa -> bbbbbbb live"
  expect_eq "api untouched by web release" "$(unit_pid api)" "$api_pid"
  expect_eq "api unit" "$(x 'systemctl is-active demo-api')" "active"
  expect_eq "api served" "$(served 8102)" "2222222"
  expect_eq "web served" "$(served 8101)" "bbbbbbb"
}

case_keeps_five() {
  local s shas="1000001 1000002 1000003 1000004 1000005 1000006 1000007"
  for s in $shas; do bundle demo web "$s" 8101 good; done
  for s in $shas; do release web "$s" 8101; expect_rc 0; done
  expect_eq "releases" "$(x 'ls -A /opt/demo/web/releases | sort | tr "\n" " "')" \
    "1000003 1000004 1000005 1000006 1000007 "
  expect_eq "REVISION" "$(x 'cat /opt/demo/web/current/REVISION')" "1000007"
  expect_eq "previous" "$(link web previous)" "/opt/demo/web/releases/1000006"
  expect_eq "hooks follow releases" "$(x 'ls -A /opt/demo/web/hooks | sort | tr "\n" " "')" \
    "1000003.sh 1000004.sh 1000005.sh 1000006.sh 1000007.sh "
  release web 1000007 8101 --keep 2
  expect_rc 0
  expect_last "shukka: demo/web 1000007 -> 1000007 live"
  expect_eq "releases with --keep 2" "$(x 'ls -A /opt/demo/web/releases | sort | tr "\n" " "')" "1000006 1000007 "
  expect_eq "previous after redeploying the live sha" "$(link web previous)" "/opt/demo/web/releases/1000006"
}

case_no_secrets_printed() {
  bundle demo web aaaaaaa 8101 good
  bundle demo web bbbbbbb 8101 unhealthy
  bundle demo web ccccccc 8101 hookfail
  local all=
  release web aaaaaaa 8101; expect_rc 0; all+=$OUT
  release web bbbbbbb 8101; expect_rc 12; all+=$OUT
  release web ccccccc 8101; expect_rc 11; all+=$OUT
  release web aaaaaaa 8101 --health http://127.0.0.1:8109/health --health-timeout 2; all+=$OUT
  x "grep -q $SECRET /opt/demo/web/settings.env" || fail "fixture did not write the secret"
  case $all in *"$SECRET"*) fail "the secret appeared in the output" ;; esac
}

case_bad_arguments() {
  bundle demo web aaaaaaa 8101 good
  OUT=$(x "bash /shukka/box/shukka-release.sh --project demo --app web" 2>&1); RC=$?
  expect_rc 2
  release web "../../etc" 8101; expect_rc 2
  release web aaaaaaa 8101 --configure box/configure.sh; expect_rc 2
  release web aaaaaaa 8101 --configure-key ../../etc/passwd; expect_rc 2
  release web aaaaaaa 8101 --configure-key /demo/web/aaaaaaa.configure.sh; expect_rc 2
  release web aaaaaaa 8101 --units 'demo-web;reboot'; expect_rc 2
  release web aaaaaaa 8101 --keep 0; expect_rc 2
  OUT=$(x "bash /shukka/box/shukka-release.sh $(release_args web aaaaaaa 8101 | sed 's/--project demo/--project Demo/')" 2>&1); RC=$?
  expect_rc 2
  x "test ! -e /opt/demo/web/current" || fail "something was released"
}

case_app_owned_base_taken_back() {
  # As on Trendigle: /opt/<project> and /opt/<project>/<app> exist, owned by the app user, and
  # the app user keeps trying to swap hooks/ for its own directory holding its own hook.
  bundle demo web aaaaaaa 8101 good
  x "install -d -o app -g app -m 755 /opt/demo /opt/demo/web /opt/demo/web/releases"
  x "install -d -o app -g app -m 777 /opt/demo/web/hooks"
  x "printf '#!/usr/bin/env bash\necho attacker >>/var/log/evil-ran\n' >/tmp/evil.sh && chmod 755 /tmp/evil.sh"
  docker exec -d "$BOX" runuser -u app -- bash -c '
    cd /opt/demo/web || exit 1
    while :; do
      mv -T hooks hooks.$RANDOM 2>/dev/null
      mkdir -p hooks 2>/dev/null; cp /tmp/evil.sh hooks/aaaaaaa.sh 2>/dev/null
      ln -sfn /tmp hooks.l 2>/dev/null && mv -Tf hooks.l hooks 2>/dev/null
    done'
  release web aaaaaaa 8101
  x "pkill -u app -f 'cd /opt/demo/web'"
  expect_rc 0
  expect_last "shukka: demo/web none -> aaaaaaa live"
  x "test ! -e /var/log/evil-ran" || fail "the attacker's hook ran as root"
  printf '%s\n' "$OUT" | grep -q "taking /opt/demo/web back for root (was app:app 755)" || fail "ownership fix not reported"
  expect_eq "dirs" "$(x 'stat -c "%n %U:%G %a" /opt/demo /opt/demo/web /opt/demo/web/releases /opt/demo/web/hooks | tr "\n" ","')" \
    "/opt/demo root:root 755,/opt/demo/web root:root 755,/opt/demo/web/releases root:root 755,/opt/demo/web/hooks root:root 700,"
  expect_eq "served" "$(served 8101)" "aaaaaaa"
}

case_symlinked_dirs_refused() {
  bundle demo web aaaaaaa 8101 good
  x "install -d -o app -g app /tmp/elsewhere /opt/demo && ln -s /tmp/elsewhere /opt/demo/web"
  release web aaaaaaa 8101
  expect_rc 10
  expect_last "shukka: demo/web none -> aaaaaaa download-failed"
  printf '%s\n' "$OUT" | grep -q "/opt/demo/web is a symlink" || fail "no clear message"
  expect_eq "nothing written through the symlink" "$(x 'ls -A /tmp/elsewhere')" ""
  x "rm /opt/demo/web && mkdir -p /opt/demo/web /tmp/hk && ln -s /tmp/hk /opt/demo/web/hooks"
  release web aaaaaaa 8101
  expect_rc 10
  expect_eq "nothing written through the hooks symlink" "$(x 'ls -A /tmp/hk')" ""
}

case_hostile_bundles() {
  bundle demo web aaaaaaa 8101 good
  local k sha
  for k in dev:bbbbbbb suid:ccccccc revsym:ddddddd; do
    sha=${k#*:}
    bundle demo web "$sha" 8101 good
    x "cd /fake-s3/$BUCKET/demo/web && python3 /fixtures/hostile-bundle.py $sha.tgz h.tgz ${k%%:*} && mv h.tgz $sha.tgz"
  done
  x "install -d /tmp/plant && echo original >/tmp/plant/victim"
  release web aaaaaaa 8101; expect_rc 0
  release web bbbbbbb 8101
  expect_rc 10
  expect_last "shukka: demo/web aaaaaaa -> bbbbbbb download-failed"
  printf '%s\n' "$OUT" | grep -q "not regular files, directories or symlinks: .*fifo" || fail "no clear message for devices and fifo"
  x "test ! -e /opt/demo/web/releases/bbbbbbb" || fail "the device bundle was kept"
  expect_eq "no leftovers" "$(x 'ls -A /opt/demo/web/releases | tr "\n" " "')" "aaaaaaa "
  expect_eq "current" "$(link web current)" "/opt/demo/web/releases/aaaaaaa"
  release web ccccccc 8101
  expect_rc 0
  expect_eq "setuid, setgid or world-writable entries" \
    "$(x 'find /opt/demo/web/releases/ccccccc ! -type l \( -perm /6000 -o -perm -0002 \) -printf "%P "')" ""
  x "test -f /opt/demo/web/releases/ccccccc/suid" || fail "fixture did not carry the setuid file"
  release web ddddddd 8101
  expect_rc 0
  expect_eq "victim untouched" "$(x 'cat /tmp/plant/victim')" "original"
  x "test -f /opt/demo/web/releases/ddddddd/REVISION && test ! -L /opt/demo/web/releases/ddddddd/REVISION" || fail "REVISION is not a regular file"
  expect_eq "REVISION" "$(x 'cat /opt/demo/web/current/REVISION')" "ddddddd"
}

case_lock_root_only() {
  bundle demo web aaaaaaa 8101 good
  x "install -d -o app -g app /opt/demo /opt/demo/web && install -o app -g app -m 666 /dev/null /opt/demo/web/.lock"
  release web aaaaaaa 8101
  expect_rc 0
  expect_eq "lock" "$(x 'stat -c "%U:%G %a" /opt/demo/web/.lock')" "root:root 600"
  if x "runuser -u app -- flock -n /opt/demo/web/.lock true" 2>/dev/null; then fail "the app user could take the lock"; fi
}

# ---------------------------------------------------------------------------------------------

cases=(
  "shu-766: a healthy release goes live and exits 0 with the last line|case_success"
  "shu-766: a download or unpack failure exits 10 and changes nothing|case_download_failed"
  "shu-766: runs only the hook from S3, never the one at the same path inside the bundle|case_hook_from_s3_only"
  "shu-766: a configure failure exits 11, switches nothing and deletes the new release|case_configure_failed"
  "shu-766: an unhealthy release rolls back to previous, restarts and checks it, exits 12|case_rolled_back"
  "shu-766: an unhealthy rollback exits 13|case_rollback_unhealthy"
  "shu-766: an unhealthy first release has nothing to roll back to and exits 13|case_first_release_unhealthy"
  "shu-766: two releases of one app at once are serialised by flock|case_same_app_serialised"
  "shu-766: releases of two apps do not wait for each other and leave each other running|case_two_apps_independent"
  "shu-766: keeps the last 5 releases and current/REVISION holds the sha|case_keeps_five"
  "shu-766: never prints the contents of settings files|case_no_secrets_printed"
  "shu-766: rejects missing or unsafe arguments with exit 2 and changes nothing|case_bad_arguments"
  "shu-766: takes app-owned directories back for root, so a hooks/ swap never runs the attacker's hook|case_app_owned_base_taken_back"
  "shu-766: refuses to release through a symlinked directory with exit 10|case_symlinked_dirs_refused"
  "shu-766: refuses devices and fifos (exit 10), strips setuid, setgid and world-write, never writes through REVISION|case_hostile_bundles"
  "shu-766: the lock file is root-only and the app user cannot flock it|case_lock_root_only"
)

ran=0
for entry in "${cases[@]}"; do
  name=${entry%|*} fn=${entry##*|}
  case $name in *"$pattern"*) ;; *) continue ;; esac
  ran=$((ran + 1))
  case_failed=0
  if new_box; then "$fn"; else fail "could not start a container"; fi
  if [ "$case_failed" = 0 ]; then echo "ok   $name"; else echo "FAIL $name"; failed=$((failed + 1)); fi
  docker rm -f "$BOX" >/dev/null 2>&1
done

echo "$ran cases, $failed failed"
[ "$ran" -gt 0 ] && [ "$failed" = 0 ]
