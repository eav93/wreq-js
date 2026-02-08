#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/aws-perf/setup-iam.sh [role-name] [instance-profile-name]

Defaults:
  role-name              wreq-js-perf-ssm-role
  instance-profile-name  wreq-js-perf-ssm-profile
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

ROLE_NAME="${1:-wreq-js-perf-ssm-role}"
PROFILE_NAME="${2:-wreq-js-perf-ssm-profile}"
POLICY_ARN="arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"

log() {
  printf '[aws-perf-iam] %s\n' "$*"
}

requires() {
  command -v "$1" >/dev/null 2>&1 || {
    printf '[aws-perf-iam] ERROR: Missing command: %s\n' "$1" >&2
    exit 1
  }
}

requires aws

trust_doc="$(mktemp)"
cat >"$trust_doc" <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "ec2.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
JSON

cleanup() {
  rm -f "$trust_doc"
}
trap cleanup EXIT

if ! aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  log "Creating role: $ROLE_NAME"
  aws iam create-role --role-name "$ROLE_NAME" --assume-role-policy-document "file://$trust_doc" >/dev/null
else
  log "Role already exists: $ROLE_NAME"
fi

log "Ensuring SSM policy attachment"
aws iam attach-role-policy --role-name "$ROLE_NAME" --policy-arn "$POLICY_ARN" >/dev/null

if ! aws iam get-instance-profile --instance-profile-name "$PROFILE_NAME" >/dev/null 2>&1; then
  log "Creating instance profile: $PROFILE_NAME"
  aws iam create-instance-profile --instance-profile-name "$PROFILE_NAME" >/dev/null
else
  log "Instance profile already exists: $PROFILE_NAME"
fi

if ! aws iam get-instance-profile \
  --instance-profile-name "$PROFILE_NAME" \
  --query "InstanceProfile.Roles[?RoleName=='$ROLE_NAME'] | length(@)" \
  --output text | grep -qx '1'; then
  log "Adding role to instance profile"
  aws iam add-role-to-instance-profile --instance-profile-name "$PROFILE_NAME" --role-name "$ROLE_NAME" >/dev/null || true
fi

log "Done. Use instance profile: $PROFILE_NAME"
