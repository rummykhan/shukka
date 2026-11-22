# shellcheck shell=bash
# How the suite calls the shukka CLI (C7). The design names the commands (`bootstrap --account`,
# `bootstrap <project>`, `diff`, `deploy`, run with `npx github:rummykhan/shukka#<tag>`) but not every
# flag. The flags below are the suite's reading and are the only place they appear; they were asked
# on shu-5ix's mailbox. Change them here, nowhere else.

# shukka <args...>: runs the CLI from the release-candidate tag, as the README tells a consumer to.
shukka() {
  npx --yes "github:$SHUKKA_REPO#$RC_TAG" "$@"
}

# `shukka bootstrap --account` (the Shukka-Account stack) is deliberately never run by this suite: that
# stack owns the account's shared GitHub OIDC provider and is created only after Trendigle's Ci stack
# releases it (shu-li5, epic 2). shukkatest imports the existing provider by ARN.

# Project bootstrap: boundary and execution policies, `cdk bootstrap --qualifier shukkatest`, and
# buildEnv values copied from /shukkatest/prod/<NAME> to the consumer's repository variables.
# Run inside the rendered consumer (it reads ./shukka.json).
cli_bootstrap_project() { # consumer-dir hosted-zone-id
  (cd "$1" && shukka bootstrap "$PROJECT" --config shukka.json --hosted-zone-id "$2" \
    --repo "$CONSUMER_REPO" --profile "$AWS_PROFILE" --region "$AWS_REGION")
}

# Emergency deploy from a laptop (R8). Run inside a clean clone at origin/main.
cli_deploy() { # consumer-dir [extra args...]
  local dir=$1
  shift
  (cd "$dir" && shukka deploy --profile "$AWS_PROFILE" "$@")
}
