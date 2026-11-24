# shellcheck shell=bash
# phase: K
# title: shukka's own CI on the release candidate, and its tests against loosened trust and a broken guard
# needs:
# critical: no

phase_K() {
  local src="$RUN_DIR/shukka-src" rc_sha
  rc_sha=$(state_get rc_sha)
  gh run list -R "$SHUKKA_REPO" --commit "$rc_sha" --limit 20 --json workflowName,status,conclusion,createdAt \
    >"$RUN_DIR/runs/shukka-ci.json" || return 1
  rm -rf "$src"
  git clone -q --depth 1 --branch "$RC_TAG" "https://github.com/$SHUKKA_REPO.git" "$src" || return 1
  (cd "$src" && npm ci --no-audit --no-fund --loglevel=error) || return 1
  (cd "$src" && npm test >"$RUN_DIR/runs/k-control.log" 2>&1)
  state_set k_control_rc $?

  # Loosened trust: each mutation is applied alone to the construct sources that hold the trust
  # conditions; the tests must fail for every one that applies.
  local files results="" m from to f applied
  files=$(grep -rl 'job_workflow_ref' "$src/lib" 2>/dev/null | tr '\n' ' ')
  for m in 'refs/heads/main=>refs/heads/*' ':pull_request=>:*' 'job_workflow_ref=>job_workflow_ref_loosened' 'sts.amazonaws.com=>*'; do
    from=${m%%=>*}
    to=${m#*=>}
    applied=0
    for f in $files; do
      if grep -qF -- "$from" "$f"; then
        FROM=$from TO=$to perl -0pi -e 's/\Q$ENV{FROM}\E/$ENV{TO}/g' "$f"
        applied=1
      fi
    done
    if [[ $applied == 1 ]]; then
      (cd "$src" && npm test >"$RUN_DIR/runs/k-trust-$(tr -c '[:lower:]' '_' <<<"$from").log" 2>&1)
      results="$results $from:$?"
      (cd "$src" && git checkout -q -- lib)
    fi
  done
  state_set k_trust_results "${results# }"

  # Broken guard: when run as a command it always says "safe" (exit 0), whatever the diff.
  if [[ -f "$src/scripts/guard.mjs" ]]; then
    perl -0pi -e 's/\A(#![^\n]*\n)?/$1if (process.argv[1] && process.argv[1].endsWith("guard.mjs")) process.exit(0);\n/' "$src/scripts/guard.mjs"
    (cd "$src" && npm test >"$RUN_DIR/runs/k-guard.log" 2>&1)
    state_set k_guard_rc $?
    (cd "$src" && git checkout -q -- scripts/guard.mjs)
  fi
}
