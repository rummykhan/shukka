# shellcheck shell=bash
# case: R3-box-role-refused-on-trendigle
# phase: D
# covers: R3.1 SC4
# title: shukkatest's server role (under the boundary) is refused on a Trendigle table and bucket (read-only attempts)

# verdict <line>: DENIED if the AWS CLI said AccessDenied, MISSING if there is no output, else ALLOWED.
verdict() {
  if grep -q AccessDenied <<<"$1"; then echo DENIED; elif [[ -z "$1" ]]; then echo MISSING; else echo ALLOWED; fi
}

case_run() {
  local t b
  t=$(state_get box_trendigle_table_read)
  b=$(state_get box_trendigle_bucket_read)
  result R3-box-role-trendigle-table-read "$(verdict "$t")" "$t"
  result R3-box-role-trendigle-bucket-read "$(verdict "$b")" "$b"
  assert_eq "$(verdict "$t")" DENIED "DescribeTable on Trendigle's table from the box is refused"
  assert_eq "$(verdict "$b")" DENIED "listing Trendigle's bucket from the box is refused"
}
