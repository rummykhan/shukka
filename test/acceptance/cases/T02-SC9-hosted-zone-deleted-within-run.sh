# shellcheck shell=bash
# case: SC9-hosted-zone-deleted-within-run
# phase: T
# covers: SC9 throwaway-zone
# title: the throwaway hosted zone was deleted within the run, well inside 12 hours of its creation

case_run() {
  local id created deleted
  id=$(need_state zone_id) || return
  created=$(need_state zone_created_epoch) || return
  deleted=$(state_get zone_deleted_epoch)
  assert_not_cmd "hosted zone $id no longer exists" aws route53 get-hosted-zone --id "$id"
  if [[ -n "$deleted" ]] && ((deleted - created < 43200)); then
    ok "deleted $(((deleted - created) / 60)) minutes after it was created"
  else
    fail "no deletion time recorded within 12 hours (created at epoch $created)"
  fi
}
