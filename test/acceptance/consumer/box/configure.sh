#!/usr/bin/env bash
# shukka configure hook for both apps (called as root: configure.sh <release-dir>, with PROJECT, APP,
# SHA and REGION set). Writes the app's user and systemd unit pointing at .../current. Idempotent.
# Does not start or restart the unit: shukka-release.sh does that after switching `current`.
set -euo pipefail
release_dir=${1:?release dir}
: "${PROJECT:?}" "${APP:?}"
case "$APP" in
  web) port=8080 ;;
  api) port=8081 ;;
  *) echo "configure: unknown app $APP" >&2; exit 1 ;;
esac
[[ -f "$release_dir/server.py" ]] || { echo "configure: $release_dir has no server.py" >&2; exit 1; }
id -u "$PROJECT" >/dev/null 2>&1 || useradd --system --no-create-home --shell /sbin/nologin "$PROJECT"
unit="/etc/systemd/system/$PROJECT-$APP.service"
cat >"$unit.tmp" <<UNIT
[Unit]
Description=$PROJECT $APP (shukka acceptance)
After=network-online.target

[Service]
User=$PROJECT
WorkingDirectory=/opt/$PROJECT/$APP/current
Environment=PORT=$port
ExecStart=/usr/bin/python3 /opt/$PROJECT/$APP/current/server.py
Restart=on-failure

[Install]
WantedBy=multi-user.target
UNIT
mv -f "$unit.tmp" "$unit"
systemctl daemon-reload
systemctl enable "$PROJECT-$APP" >/dev/null 2>&1
