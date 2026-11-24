#!/usr/bin/env bash
# Builds a fake app bundle and its configure hook and puts them in the fake S3:
#   /fake-s3/<bucket>/<project>/<app>/<sha>.tgz           the bundle
#   /fake-s3/<bucket>/<project>/<app>/<sha>.configure.sh  the hook (as ec2.yml uploads it from git)
# usage: make-bundle.sh <bucket> <project> <app> <sha> <port> <variant> [hook-sleep-seconds]
# variants:
#   good       serves 200 on /health
#   unhealthy  the unit runs but /health is 404
#   hookfail   the configure hook exits 1
# The bundle also carries a planted hook at box/configure.sh, the path the hook has in git, which
# records that it ran in /var/log/bundle-hook-ran: the release script must never run it.
# The real hook writes a settings file holding a fixture secret and a unit
# that serves <release>/public on 127.0.0.1:<port> as the unprivileged user "app". With a sleep
# it records when it started and ended in /var/log/hook-order.log.
set -euo pipefail
bucket=$1 project=$2 app=$3 sha=$4 port=$5 variant=$6 sleep_s=${7:-0}
build=$(mktemp -d)
mkdir -p "$build/public" "$build/box"
hook=$(mktemp)
echo "$sha" >"$build/public/version"
[ "$variant" = unhealthy ] || echo ok >"$build/public/health"

cat >"$hook" <<HOOK
#!/usr/bin/env bash
set -euo pipefail
rel=\$1
echo "hook: PROJECT=\$PROJECT APP=\$APP SHA=\$SHA REGION=\$REGION dir=\$rel" >>/var/log/hook-env.log
echo "configuring \$APP \$SHA"
if [ "$variant" = hookfail ]; then echo "configure failed on purpose"; exit 1; fi
if [ "$sleep_s" != 0 ]; then
  echo "start \$APP \$SHA \$(date +%s%N)" >>/var/log/hook-order.log
  sleep "$sleep_s"
  echo "end \$APP \$SHA \$(date +%s%N)" >>/var/log/hook-order.log
fi
umask 077
printf 'SECRET=%s\n' "fixture-secret-shu766-must-not-print" >/opt/\$PROJECT/\$APP/settings.env
chown app /opt/\$PROJECT/\$APP/settings.env
umask 022
cat >/etc/systemd/system/\$PROJECT-\$APP.service <<UNIT
[Service]
User=app
EnvironmentFile=/opt/\$PROJECT/\$APP/settings.env
WorkingDirectory=/opt/\$PROJECT/\$APP/current
ExecStart=python3 -m http.server --bind 127.0.0.1 $port --directory /opt/\$PROJECT/\$APP/current/public
UNIT
HOOK
cat >"$build/box/configure.sh" <<'PLANTED'
#!/usr/bin/env bash
echo "planted bundle hook ran: $*" >>/var/log/bundle-hook-ran
PLANTED
chmod 755 "$build/box/configure.sh"

mkdir -p "/fake-s3/$bucket/$project/$app"
mv "$hook" "/fake-s3/$bucket/$project/$app/$sha.configure.sh"
tar czf "/fake-s3/$bucket/$project/$app/$sha.tgz" -C "$build" .
rm -rf "$build"
