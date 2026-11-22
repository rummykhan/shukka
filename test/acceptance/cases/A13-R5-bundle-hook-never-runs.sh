# shellcheck shell=bash
# case: R5-bundle-hook-never-runs
# phase: A
# covers: R5 design-configure-hook
# title: a configure.sh planted inside the bundle is shipped but never executed; the hook that ran is the git checkout's

case_run() {
  local sha out want
  sha=$(need_state baseline_sha) || return
  want=$(shasum -a 256 "$RUN_DIR/consumer/box/configure.sh" | awk '{print $1}')
  out=$(box_run "test -f /opt/$PROJECT/web/current/box/configure.sh && echo shipped || echo not-shipped
test -e /var/tmp/shukkatest-planted-hook-ran && echo planted-ran || echo planted-never-ran
sha256sum /opt/$PROJECT/web/hooks/$sha.sh 2>/dev/null | cut -d' ' -f1 || true")
  assert_match "$out" '^shipped$' "the planted box/configure.sh is inside the deployed release"
  assert_match "$out" '^planted-never-ran$' "the planted hook was never executed"
  assert_match "$out" "^$want\$" "the hook kept at /opt/$PROJECT/web/hooks/<sha>.sh is the git checkout's box/configure.sh"
}
