# shellcheck shell=bash
# case: R2-oidc-provider-intact-after-run
# phase: T
# covers: R2.3 safety
# title: the account's GitHub OIDC provider (Trendigle's) still exists after teardown

case_run() {
  local arn
  arn=$(need_state oidc_provider_arn) || return
  assert_cmd "the provider still exists" aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$arn"
}
