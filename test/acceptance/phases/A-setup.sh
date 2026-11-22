# shellcheck shell=bash
# phase: A
# title: setup: zone, stand-in project, account stack, project bootstrap, Ci stack, first merge
# needs:
# critical: yes

phase_A() {
  setup_discover
  setup_zone
  setup_param
  setup_standin
  setup_render
  setup_bootstrap_project
  setup_ci_stack
  setup_push_baseline
  snapshot after_baseline
}

# snapshot <prefix>: what later cases compare against (stack update times, deployed revisions).
snapshot() {
  local p=$1
  state_set "${p}_box_updated" "$(stack_last_updated Shukkatest-Box)"
  state_set "${p}_box_revision" "$(stack_tag Shukkatest-Box shukka:revision)"
  state_set "${p}_web_rev" "$(server_revision web)"
  state_set "${p}_api_rev" "$(server_revision api)"
  state_set "${p}_api_unit" "$(unit_started api)"
}
