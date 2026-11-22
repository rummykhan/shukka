#!/usr/bin/env bash
# shukka-release.sh: release one app on this server, with rollback. Runs as root, sent by ec2.yml
# through SSM Run Command. Knows nothing about any particular project.
#
# usage: shukka-release.sh --project P --app A --sha SHA --bucket B --region R
#                          --configure-key <s3 key of the hook>   (uploaded by ec2.yml from git)
#                          --configure-sha256 <hex> --bundle-sha256 <hex>   (digests of what was uploaded)
#                          --units "u1 u2" --health URL [--keep 5] [--health-timeout 60]
#
# Layout: /opt/<project>/<app>/releases/<sha>/ (bundle + REVISION), current -> one release,
# previous -> the one before, hooks/<sha>.sh (root, 0700), .lock (flock: one release of an app at a time; apps do not wait for
# each other). The last --keep releases are kept.
#
# Exit codes, and the result word on the last line of stdout:
#   0  live                new release live and healthy
#   2  invalid-arguments   bad or missing arguments (nothing changed)
#   10 download-failed     download or unpack failed, a digest differs, or the layout cannot be
#                          made root's (nothing changed)
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
#
# The hook and the bundle are checked against the sha256 digests release.mjs computed when it
# uploaded them; a different object in S3 is refused (exit 10) before it is run or unpacked.
# Before anything else, whatever in releases/ and hooks/ is not root's (left by whoever owned the
# base before the first release) is removed, with current/previous links pointing at it.
set -uo pipefail
umask 022
export LC_ALL=C

project='' app='' sha='' bucket='' region='' configure_key='' configure_sha256='' bundle_sha256='' units='' health='' keep=5 health_timeout=60
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
    --configure-sha256) configure_sha256=$2 ;;
    --bundle-sha256) bundle_sha256=$2 ;;
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
[[ $configure_sha256 =~ ^[0-9a-f]{64}$ ]] || invalid "--configure-sha256 must be 64 lowercase hex characters"
[[ $bundle_sha256 =~ ^[0-9a-f]{64}$ ]] || invalid "--bundle-sha256 must be 64 lowercase hex characters"
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

# Every directory on the way to what this script runs as root must be root's: a real directory
# (not a symlink), owned by root:root and not writable by group or others. Otherwise whoever can
# write there could swap hooks/ or a release under us. An existing directory owned by the app user
# (as Trendigle's /opt/trendigle is) is taken back for root, that directory alone, not recursively.
# Top down, so each directory is fixed before anything below it is looked at.
secure_dir() {
  local d=$1 st
  if [ -L "$d" ]; then
    say "$d is a symlink; refusing to release through it"
    finish 10 download-failed
  fi
  if [ ! -e "$d" ]; then
    mkdir -m 755 -- "$d" || { say "cannot create $d"; finish 10 download-failed; }
  fi
  if [ ! -d "$d" ]; then
    say "$d is not a directory"
    finish 10 download-failed
  fi
  st=$(stat -c '%u:%g %a' -- "$d") || finish 10 download-failed
  if [ "${st%% *}" != 0:0 ] || [ $((8#${st#* } & 8#022)) -ne 0 ]; then
    say "taking $d back for root (was $(stat -c '%U:%G %a' -- "$d")): chown root:root, chmod go-w"
    if ! { chown root:root -- "$d" && chmod go-w -- "$d"; }; then finish 10 download-failed; fi
  fi
}
for d in /opt "/opt/$project" "$base" "$releases" "$hooks"; do secure_dir "$d"; done
chmod 700 -- "$hooks" || finish 10 download-failed

# The lock file is root's alone (0600), so no other user can take it and stall releases.
# Created only when missing (never replaced: a running release may hold it); opened in append mode
# so it is never truncated. Children get fd 9 closed (9>&-), so nothing they leave running (a
# daemon a hook starts) can hold the lock.
lock=$base/.lock
if [ -L "$lock" ] || { [ -e "$lock" ] && [ ! -f "$lock" ]; }; then rm -rf -- "$lock"; fi
if ! { (umask 077 && : >>"$lock") && chown root:root -- "$lock" && chmod 600 -- "$lock"; }; then
  finish 10 download-failed
fi
exec 9>>"$lock" || finish 10 download-failed
if ! flock -n 9; then
  say "waiting for another release of $project/$app to finish"
  flock 9 || finish 10 download-failed
fi

# Leftovers from a release that was killed half way (we hold the lock, so none is running).
find "$releases" -mindepth 1 -maxdepth 1 -name '.new-*' -exec rm -rf -- {} + 2>/dev/null

find "$hooks" -mindepth 1 -maxdepth 1 -name '.new-*' -exec rm -f -- {} + 2>/dev/null

# Entries not made by this script as root: before the first release the base may have been the app
# user's, who could plant releases/<sha>, hooks/<sha>.sh and current/previous pointing at them, for
# a rollback to configure as root. A release is kept only as a real directory owned by root; a hook
# only as a regular root:root 0700 file. secure_dir made both directories root's, and we hold the
# lock, so nothing can be added while we look.
for e in "$releases"/* "$releases"/.[!.]* "$hooks"/* "$hooks"/.[!.]*; do
  [ -e "$e" ] || [ -L "$e" ] || continue
  st=$(stat -c '%F %u:%g %a' -- "$e") || finish 10 download-failed
  case $e in
    "$releases"/*) [ "${st% *}" = "directory 0:0" ] && continue ;;
    *) [ "$st" = "regular file 0:0 700" ] && continue ;;
  esac
  say "removing $e (owned by $(stat -c '%U:%G' -- "$e"), $st): not made by this script"
  rm -rf -- "$e" || finish 10 download-failed
done
target_of() { readlink -- "$1" 2>/dev/null; }
# current and previous must be symlinks to releases/<hex sha>, a release kept above.
for l in "$base/current" "$base/previous"; do
  [ -e "$l" ] || [ -L "$l" ] || continue
  t=$(target_of "$l")
  if [ -L "$l" ] && [[ $t =~ ^$releases/[0-9a-f]{7,40}$ ]] && [ -d "$t" ] && [ ! -L "$t" ]; then continue; fi
  # Whatever is not a symlink (a directory or file, whoever owns it) may hold the app's own data:
  # never delete it, refuse instead.
  if [ ! -L "$l" ]; then
    say "$l is not a symlink; refusing to release over it"
    finish 10 download-failed
  fi
  say "removing $l (pointing at ${t:-nothing}): not a release made by this script"
  rm -rf -- "$l" || finish 10 download-failed
done

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
got=$(sha256sum <"$hook_tmp" | cut -c1-64)
if [ "$got" != "$configure_sha256" ]; then
  say "the configure hook does not match its sha256 (got $got, expected $configure_sha256); refusing it"
  finish 10 download-failed
fi
if ! { chown root:root -- "$hook_tmp" && chmod 700 -- "$hook_tmp" && mv -f -- "$hook_tmp" "$hook"; }; then
  finish 10 download-failed
fi
hook_tmp=
# Run the hook from this open file, never again by path, so it cannot be swapped after download.
exec 8<"$hook" || finish 10 download-failed

# --- download and unpack, unless this sha is the live release -----------------------------------
# A bundle that cannot be used leaves nothing behind: its hook goes too, unless that hook belongs to
# the live or the previous release (redeploying that sha).
bundle_failed() {
  [ "$new_dir" = "$old_target" ] || [ "$new_dir" = "$prev_target" ] || rm -f -- "$hook"
  finish 10 download-failed
}
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
    bundle_failed
  fi
  got=$(sha256sum <"$tgz" | cut -c1-64)
  if [ "$got" != "$bundle_sha256" ]; then
    say "the bundle does not match its sha256 (got $got, expected $bundle_sha256); refusing it"
    bundle_failed
  fi
  mkdir -m 755 -- "$staging" || finish 10 download-failed
  if ! tar -xzf "$tgz" -C "$staging" --no-same-owner --no-same-permissions; then
    say "unpack failed"
    bundle_failed
  fi
  # Only regular files, directories and symlinks; no setuid, setgid or world-writable bits.
  # (chmod -R does not follow symlinks met while recursing.)
  odd=$(find "$staging" ! -type f ! -type d ! -type l -printf '%P\n' | head -n 5)
  if [ -n "$odd" ]; then
    say "the bundle holds entries that are not regular files, directories or symlinks: ${odd//$'\n'/ }"
    bundle_failed
  fi
  chmod -R u-s,g-s,o-w -- "$staging" || finish 10 download-failed
  chmod 755 -- "$staging"
  # Never write through a bundle entry as root: remove whatever is named REVISION first.
  rm -rf -- "$staging/REVISION"
  printf '%s\n' "$sha" >"$staging/REVISION" || finish 10 download-failed
  rm -f -- "$tgz"; tgz=
  # Redeploying an older sha (often the one `previous` points at): swap the fresh copy in, then
  # drop the old one, so `previous` is never left dangling.
  aside=''
  if [ -e "$new_dir" ] || [ -L "$new_dir" ]; then
    aside=$releases/.new-old-$sha.$$
    mv -T -- "$new_dir" "$aside" || finish 10 download-failed
  fi
  mv -T -- "$staging" "$new_dir" || finish 10 download-failed
  staging=
  [ -n "$aside" ] && rm -rf -- "$aside"
fi

# --- configure ---------------------------------------------------------------------------------
# A failed release is deleted with its hook, unless it is the live one (redeploying the live sha)
# or the one `previous` points at (redeploying that sha), which must stay.
drop_new() {
  [ "$rerelease" = 1 ] && return
  [ "$new_dir" = "$prev_target" ] && return
  rm -rf -- "$new_dir" "$hook"
}

say "running the configure hook"
if ! (cd -- "$new_dir" && PROJECT=$project APP=$app SHA=$sha REGION=$region bash /dev/fd/8 "$new_dir" </dev/null 2>&1 9>&-); then
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
if [ -z "$rollback_to" ] || [[ ! $rollback_to =~ ^$releases/[0-9a-f]{7,40}$ ]] || [ ! -d "$rollback_to" ] || [ -L "$rollback_to" ]; then
  say "no previous release to roll back to; manual attention needed"
  finish 13 rollback-unhealthy
fi
rollback_sha=${rollback_to##*/}
say "rolling back to $rollback_sha"
point "$base/current" "$rollback_to"
if [ -n "$prev_target" ]; then point "$base/previous" "$prev_target"; else rm -f -- "$base/previous"; fi
drop_new
# Give the previous release its own settings and units back: re-run its kept hook, again from an
# open file, only when the release is a root:root directory not writable by group or others and
# the hook is a regular root:root 0700 file. If it is missing, unusable or fails, the release is
# restarted as it is and the health check still decides.
rollback_hook=$hooks/$rollback_sha.sh
dir_st=$(stat -c '%F %u:%g %a' -- "$rollback_to" 2>/dev/null)
hook_st=$(stat -c '%F %u:%g %a' -- "$rollback_hook" 2>/dev/null)
if [ "${dir_st% *}" = "directory 0:0" ] && [ $((8#${dir_st##* } & 8#022)) -eq 0 ] \
  && [ "$hook_st" = "regular file 0:0 700" ] && exec 7<"$rollback_hook"; then
  say "running the configure hook of $rollback_sha"
  if ! (cd -- "$rollback_to" && PROJECT=$project APP=$app SHA=$rollback_sha REGION=$region bash /dev/fd/7 "$rollback_to" </dev/null 2>&1 8<&- 9>&-); then
    say "the configure hook of $rollback_sha failed"
  fi
else
  say "no usable configure hook kept for $rollback_sha; restarting it as it is"
fi
if restart_units && healthy "$rollback_sha"; then
  finish 12 rolled-back
fi
say "the rollback is unhealthy too; manual attention needed"
finish 13 rollback-unhealthy
