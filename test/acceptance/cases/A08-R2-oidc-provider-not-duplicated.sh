# shellcheck shell=bash
# case: R2-oidc-provider-not-duplicated
# phase: A
# covers: R2.3
# title: adding ShukkaAccess for a second project in the account reuses the existing GitHub OIDC provider

case_run() {
  local before now arn tpl
  before=$(need_state oidc_provider_arn) || return
  now=$(aws iam list-open-id-connect-providers --query 'OpenIDConnectProviderList[].Arn' --output text | tr '\t' '\n' |
    grep 'token.actions.githubusercontent.com' || true)
  assert_eq "$(grep -c . <<<"$now")" 1 "the account still has exactly one GitHub OIDC provider"
  assert_eq "$now" "$before" "it is the same provider as before the run"
  assert_match "$(stack_status Shukkatest-Ci)" '^(CREATE|UPDATE)_COMPLETE$' "Shukkatest-Ci (ShukkaAccess) deployed"
  tpl=$(aws cloudformation get-template --stack-name Shukkatest-Ci --query TemplateBody --output json)
  assert_no_match "$tpl" 'AWS::IAM::OIDCProvider|OpenIdConnectProvider' "Shukkatest-Ci creates no OIDC provider of its own"
  arn=$(aws cloudformation describe-stacks --stack-name Shukka-Account --query 'Stacks[0].Outputs[].OutputValue' --output text 2>/dev/null)
  assert_match "$arn" "${before//./\\.}" "Shukka-Account outputs the provider's ARN"
}
