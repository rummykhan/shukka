# shellcheck shell=bash
# case: R1-caller-is-the-whole-ci
# phase: A
# covers: R1.1 R9.2-shape SC1
# title: the consumer's only CI file is a short caller of pipeline.yml at the rc tag, with settings only

case_run() {
  local sha files body n
  sha=$(need_state baseline_sha) || return
  files=$(gh api "repos/$CONSUMER_REPO/contents/.github/workflows?ref=$sha" --jq '.[].name' | tr '\n' ' ' | sed 's/ $//')
  assert_eq "$files" "ci.yml" "the only workflow file on main is ci.yml"
  body=$(gh api "repos/$CONSUMER_REPO/contents/.github/workflows/ci.yml?ref=$sha" --jq .content | base64 --decode)
  assert_match "$body" "uses: *rummykhan/shukka/\\.github/workflows/pipeline\\.yml@$RC_TAG\$" "it calls pipeline.yml at $RC_TAG"
  assert_no_match "$body" '^[[:space:]]*(steps|run|runs-on):' "it has no steps, run commands or runners of its own"
  assert_no_match "$body" 'arn:aws|role-to-assume|aws-actions' "it holds no IAM or AWS configuration"
  n=$(grep -c . <<<"$body")
  if ((n <= 20)); then ok "it is short ($n non-empty lines)"; else fail "it is $n non-empty lines (a caller should be about 10)"; fi
  assert_cmd "shukka.json is at the repository root" gh api "repos/$CONSUMER_REPO/contents/shukka.json?ref=$sha"
}
