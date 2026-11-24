# shellcheck shell=bash
# case: SC1-throwaway-project-resources
# phase: A
# covers: SC1 R3.2
# title: the merge created shukkatest's instance, elastic IP, security group, launch template, role and profile, table, bucket and DNS record

case_run() {
  local iid ip profile zone name rec acct
  acct=$(state_get account)
  iid=$(box_instance)
  assert_ne "$iid" "" "a running instance tagged Project=shukkatest exists"
  ip=$(box_ip)
  assert_match "$ip" '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' "the stack outputs a public IP"
  assert_eq "$(aws ec2 describe-addresses --filters "Name=instance-id,Values=$iid" --query 'Addresses[0].PublicIp' --output text)" "$ip" \
    "the elastic IP is associated with the instance"
  assert_eq "$(aws ec2 describe-addresses --filters "Name=instance-id,Values=$iid" --query "Addresses[0].Tags[?Key=='Project'].Value | [0]" --output text)" \
    shukkatest "the elastic IP is tagged Project=shukkatest"
  assert_ne "$(aws ec2 describe-security-groups --filters Name=group-name,Values=shukkatest-box --query 'SecurityGroups[0].GroupId' --output text)" None \
    "security group shukkatest-box exists"
  assert_ne "$(aws ec2 describe-launch-templates --filters Name=tag:Project,Values=shukkatest --query 'LaunchTemplates[0].LaunchTemplateId' --output text)" None \
    "a launch template tagged Project=shukkatest exists"
  profile=$(aws ec2 describe-instances --instance-ids "$iid" --query 'Reservations[0].Instances[0].IamInstanceProfile.Arn' --output text)
  assert_match "$profile" 'instance-profile/[Ss]hukkatest' "the instance has a shukkatest instance profile"
  assert_eq "$(aws iam get-instance-profile --instance-profile-name "${profile##*/}" --query 'InstanceProfile.Roles[0].RoleName' --output text)" \
    shukkatest-box "the profile carries role shukkatest-box"
  assert_eq "$(table_status shukkatest-items)" ACTIVE "table shukkatest-items is active"
  assert_cmd "bucket shukkatest-deploy-<account> exists" aws s3api head-bucket --bucket "shukkatest-deploy-$acct"
  zone=$(need_state zone_id) || return
  name="box.$(need_state zone_name)" || return
  rec=$(aws route53 list-resource-record-sets --hosted-zone-id "$zone" \
    --query "ResourceRecordSets[?Name=='$name.' && Type=='A'].ResourceRecords[0].Value | [0]" --output text)
  assert_eq "$rec" "$ip" "the throwaway zone has $name -> the elastic IP"
  assert_eq "$(http_code "http://$ip:8080/health")" 200 "web answers /health on the elastic IP"
}
