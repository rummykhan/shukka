#!/usr/bin/env bash
# shukka-release.sh: release one app on this server, with rollback. Runs as root, sent by ec2.yml
# through SSM Run Command. Knows nothing about any particular project.
#
# usage: shukka-release.sh --project P --app A --sha SHA --bucket B --region R
#                          --configure-key <s3 key of the hook>   (uploaded by ec2.yml from git)
#                          --units "u1 u2" --health URL [--keep 5] [--health-timeout 60]
#
# Layout: /opt/<project>/<app>/releases/<sha>/ (bundle + REVISION), current -> one release,
# previous -> the one before, hooks/<sha>.sh (root, 0700), .lock (flock: one release of an app at a time; apps do not wait for
# each other). The last --keep releases are kept.
#
# Exit codes, and the result word on the last line of stdout:
#   0  live                new release live and healthy
#   2  invalid-arguments   bad or missing arguments (nothing changed)
#   10 download-failed     download or unpack failed (nothing changed)
#   11 configure-failed    configure hook failed (nothing switched; the new release is deleted)
#   12 rolled-back         unhealthy, rolled back, previous healthy
#   13 rollback-unhealthy  unhealthy, and the rollback is unhealthy too or there is nothing to roll
#                          back to (manual attention)
# Last line: "shukka: <project>/<app> <old-sha> -> <new-sha> <result>" (old-sha is "none" on a
# first release).
#
# Configure hook: downloaded from s3://<bucket>/<configure-key> to /opt/<project>/<app>/hooks/<sha>.sh,
# outside every release directory, and only that file is run; nothing inside the bundle is ever
# run as the hook (a build dependency could plant a file there). Called as `hook.sh <release-dir>` with PROJECT, APP, SHA, REGION set, as root.
# It writes settings, users and units (pointing at /opt/<project>/<app>/current), is idempotent and
# never starts or restarts the app's units. This script never prints settings files.
set -uo pipefail
umask 022
export LC_ALL=C

project='' app='' sha='' bucket='' region='' configure_key='' units='' health='' keep=5 health_timeout=60
old=none
staging='' tgz='' hook_tmp=''

say() { printf 'shukka: %s\n' "$*"; }

finish() { # finish <exit-code> <result>
  printf 'shukka: %s/%s %s -> %s %s\n' "${project:-?}" "${app:-?}" "$old" "${sha:-?}" "$2"
  exit "$1"
}

# shellcheck disable=SC2329 # called by the EXIT trap
cleanup() {
  [ -n "$tgz" ] && rm -f -- "$tgz"
  [ -n "$staging" ] && rm -rf -- "$staging"
  [ -n "$hook_tmp" ] && rm -f -- "$hook_tmp"
}
trap cleanup EXIT

invalid() {
  say "invalid arguments: $*" >&2
  # Only echo values back once they are known to be safe.
  [[ $project =~ ^[a-z][a-z0-9-]{1,20}$ ]] || project='?'
  [[ $app =~ ^[a-z][a-z0-9-]{0,39}$ ]] || app='?'
  [[ $sha =~ ^[0-9a-f]{7,40}$ ]] || sha='?'
  finish 2 invalid-arguments
}

while [ $# -gt 0 ]; do
  [ $# -ge 2 ] || invalid "$1 needs a value"
  case $1 in
    --project) project=$2 ;;
    --app) app=$2 ;;
    --sha) sha=$2 ;;
    --bucket) bucket=$2 ;;
    --region) region=$2 ;;
    --configure-key) configure_key=$2 ;;
    --units) units=$2 ;;
    --health) health=$2 ;;
    --keep) keep=$2 ;;
    --health-timeout) health_timeout=$2 ;;
    *) invalid "unknown argument" ;;
  esac
  shift 2
done

[[ $project =~ ^[a-z][a-z0-9-]{1,20}$ ]] || invalid "--project must match ^[a-z][a-z0-9-]{1,20}\$"
[[ $app =~ ^[a-z][a-z0-9-]{0,39}$ ]] || invalid "--app must match ^[a-z][a-z0-9-]{0,39}\$"
[[ $sha =~ ^[0-9a-f]{7,40}$ ]] || invalid "--sha must be 7 to 40 lowercase hex characters"
[[ $bucket =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || invalid "--bucket is not a bucket name"
[[ $region =~ ^[a-z]{2}(-[a-z]+)+-[0-9]+$ ]] || invalid "--region is not a region"
[[ $configure_key =~ ^[A-Za-z0-9._-][A-Za-z0-9._/-]*$ ]] || invalid "--configure-key must be an S3 key"
[[ /$configure_key/ == */../* || /$configure_key/ == */./* ]] && invalid "--configure-key must not contain . or .. segments"
[[ $health =~ ^https?://[^[:space:]]+$ ]] || invalid "--health must be an http(s) URL"
[[ $keep =~ ^[1-9][0-9]?$ ]] || invalid "--keep must be 1 to 99"
[[ $health_timeout =~ ^[1-9][0-9]{0,3}$ ]] || invalid "--health-timeout must be 1 to 9999 seconds"
read -r -a unit_list <<<"$units"
[ "${#unit_list[@]}" -gt 0 ] || invalid "--units needs at least one unit"
for u in "${unit_list[@]}"; do
  [[ $u =~ ^[A-Za-z0-9][A-Za-z0-9@._-]*$ ]] || invalid "--units: bad unit name"
done

base=/opt/$project/$app
releases=$base/releases
new_dir=$releases/$sha
hooks=$base/hooks
hook=$hooks/$sha.sh

mkdir -p -- "$releases" || finish 10 download-failed
# Append mode so the lock file is never truncated, whatever it is. Children get fd 9 closed
# (9>&-), so nothing they leave running (a daemon a hook starts) can hold the lock.
exec 9>>"$base/.lock" || finish 10 download-failed
if ! flock -n 9; then
  say "waiting for another release of $project/$app to finish"
  flock 9 || finish 10 download-failed
fi

# Leftovers from a release that was killed half way (we hold the lock, so none is running).
find "$releases" -mindepth 1 -maxdepth 1 -name '.new-*' -exec rm -rf -- {} + 2>/dev/null

# The hooks directory is root's alone: whatever owns /opt/<project>/<app>, nothing else may place
# or swap a file that this script runs as root.
if [ -L "$hooks" ] || { [ -e "$hooks" ] && [ ! -d "$hooks" ]; }; then rm -f -- "$hooks"; fi
if ! { mkdir -p -- "$hooks" && chown root:root -- "$hooks" && chmod 700 -- "$hooks"; }; then
  finish 10 download-failed
fi
find "$hooks" -mindepth 1 -maxdepth 1 -name '.new-*' -exec rm -f -- {} + 2>/dev/null

target_of() { readlink -- "$1" 2>/dev/null; }
old_target=$(target_of "$base/current")
prev_target=$(target_of "$base/previous")
if [ -n "$old_target" ]; then
  old=$(head -c 64 -- "$old_target/REVISION" 2>/dev/null | head -n 1)
  [[ $old =~ ^[0-9a-f]{7,40}$ ]] || old=unknown
fi

# Points <link> at <target> atomically.
point() {
  ln -sfn -- "$2" "$1.tmp.$$" && mv -Tf -- "$1.tmp.$$" "$1"
}

units_active() {
  local u
  for u in "${unit_list[@]}"; do
    systemctl is-active --quiet "$u" 9>&- || { why="unit $u is not active"; return 1; }
  done
}

# healthy <sha>: HTTP GET every 2 s until 2xx/3xx with every unit active, or the timeout.
healthy() {
  local code deadline=$((SECONDS + health_timeout))
  why=
  say "checking health of $1"
  while :; do
    if units_active; then
      code=$(curl -q -s -o /dev/null -w '%{http_code}' --max-time 5 -- "$health" 2>/dev/null)
      [[ $code =~ ^[23][0-9][0-9]$ ]] && { say "healthy: $1"; return 0; }
      why="health check returned ${code:-no response}"
    fi
    [ "$SECONDS" -ge "$deadline" ] && { say "unhealthy: $1 ($why)"; return 1; }
    sleep 2
  done
}

restart_units() {
  say "restarting ${unit_list[*]}"
  systemctl daemon-reload 9>&-
  systemctl restart -- "${unit_list[@]}" 9>&-
}

# --- download the hook (from git, through S3; never from the bundle) ----------------------------
hook_tmp=$hooks/.new-$sha.$$
say "downloading the configure hook s3://$bucket/$configure_key"
if ! aws s3 cp "s3://$bucket/$configure_key" "$hook_tmp" --region "$region" --only-show-errors 9>&-; then
  say "hook download failed"
  finish 10 download-failed
fi
if ! { chown root:root -- "$hook_tmp" && chmod 700 -- "$hook_tmp" && mv -f -- "$hook_tmp" "$hook"; }; then
  finish 10 download-failed
fi
hook_tmp=

# --- download and unpack, unless this sha is the live release -----------------------------------
if [ "$old_target" = "$new_dir" ] && [ -d "$new_dir" ]; then
  say "$sha is already the live release; configuring and restarting it again"
  rerelease=1
else
  rerelease=0
  staging=$releases/.new-$sha.$$
  tgz=$staging.tgz
  say "downloading s3://$bucket/$project/$app/$sha.tgz"
  if ! aws s3 cp "s3://$bucket/$project/$app/$sha.tgz" "$tgz" --region "$region" --only-show-errors 9>&-; then
    say "download failed"
    finish 10 download-failed
  fi
  mkdir -m 755 -- "$staging" || finish 10 download-failed
  if ! tar -xzf "$tgz" -C "$staging" --no-same-owner --no-same-permissions; then
    say "unpack failed"
    finish 10 download-failed
  fi
  chmod 755 -- "$staging"
  rm -f -- "$staging/REVISION"
  printf '%s\n' "$sha" >"$staging/REVISION" || finish 10 download-failed
  rm -f -- "$tgz"; tgz=
  rm -rf -- "$new_dir"
  mv -T -- "$staging" "$new_dir" || finish 10 download-failed
  staging=
fi

# --- configure ---------------------------------------------------------------------------------
drop_new() { [ "$rerelease" = 1 ] || rm -rf -- "$new_dir" "$hook"; }

say "running the configure hook"
if ! (cd -- "$new_dir" && PROJECT=$project APP=$app SHA=$sha REGION=$region bash -- "$hook" "$new_dir" </dev/null 2>&1 9>&-); then
  say "configure hook failed; nothing switched"
  drop_new
  finish 11 configure-failed
fi

# --- switch and check --------------------------------------------------------------------------
if [ -n "$old_target" ] && [ "$old_target" != "$new_dir" ]; then
  point "$base/previous" "$old_target"
fi
point "$base/current" "$new_dir"
touch -- "$new_dir/REVISION"
say "current -> $sha"

if restart_units && healthy "$sha"; then
  # Prune: keep the newest --keep releases (by when they went live), never current or previous.
  cur=$(target_of "$base/current") prev=$(target_of "$base/previous") n=0
  while read -r _ dir; do
    n=$((n + 1))
    [ "$n" -le "$keep" ] && continue
    [ "$dir" = "$cur" ] || [ "$dir" = "$prev" ] && continue
    say "pruning ${dir##*/}"
    rm -rf -- "$dir"
  done < <(find "$releases" -mindepth 2 -maxdepth 2 -name REVISION -path "$releases/[!.]*" -printf '%T@ %h\n' | sort -rn)
  for h in "$hooks"/*.sh; do
    [ -e "$h" ] || continue
    r=${h##*/}; r=${r%.sh}
    [ -d "$releases/$r" ] || rm -f -- "$h"
  done
  finish 0 live
fi

# --- roll back ---------------------------------------------------------------------------------
if [ "$rerelease" = 1 ]; then rollback_to=$prev_target; else rollback_to=$old_target; fi
if [ -z "$rollback_to" ] || [ ! -d "$rollback_to" ]; then
  say "no previous release to roll back to; manual attention needed"
  finish 13 rollback-unhealthy
fi
rollback_sha=${rollback_to##*/}
say "rolling back to $rollback_sha"
point "$base/current" "$rollback_to"
if [ -n "$prev_target" ]; then point "$base/previous" "$prev_target"; else rm -f -- "$base/previous"; fi
drop_new
if restart_units && healthy "$rollback_sha"; then
  finish 12 rolled-back
fi
say "the rollback is unhealthy too; manual attention needed"
finish 13 rollback-unhealthy
