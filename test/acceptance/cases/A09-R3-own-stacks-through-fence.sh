# shellcheck shell=bash
# case: R3-own-stacks-through-fence
# phase: A
# covers: R3.2
# title: shukkatest's stacks deploy through its own limited execution role and every role they create carries the boundary

case_run() {
  local s role name pols r b
  for s in Shukkatest-Ci Shukkatest-Box; do
    role=$(aws cloudformation describe-stacks --stack-name "$s" --query 'Stacks[0].RoleARN' --output text 2>/dev/null)
    name=${role##*/}
    assert_match "$name" 'shukkatest' "$s is deployed by a shukkatest execution role ($name)"
    pols=$(aws iam list-attached-role-policies --role-name "$name" --query 'AttachedPolicies[].PolicyName' --output text 2>/dev/null)
    assert_match "$pols" 'shukkatest-shukka-' "that role carries the shukkatest execution policies"
    assert_no_match "$pols" 'AdministratorAccess|PowerUserAccess' "that role is not an administrator"
  done
  for r in $(aws iam list-roles --query 'Roles[].RoleName' --output text | tr '\t' '\n' | grep -E '^(shukkatest|Shukkatest)'); do
    b=$(aws iam get-role --role-name "$r" --query 'Role.PermissionsBoundary.PermissionsBoundaryArn' --output text)
    assert_match "$b" ':policy/shukkatest-shukka-boundary$' "role $r has the shukkatest boundary"
  done
  for r in shukkatest-shukka-infra shukkatest-shukka-app shukkatest-shukka-diff shukkatest-box; do
    assert_cmd "role $r exists" aws iam get-role --role-name "$r"
  done
}
