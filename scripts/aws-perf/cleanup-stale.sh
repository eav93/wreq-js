#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'EOF'
Usage: scripts/aws-perf/cleanup-stale.sh <region>

Example:
  scripts/aws-perf/cleanup-stale.sh us-east-1
EOF
  exit 0
fi

REGION="${1:-${AWS_REGION:-${AWS_DEFAULT_REGION:-}}}"
if [[ -z "$REGION" ]]; then
  echo "[aws-perf-cleanup] ERROR: region is required (arg1 or AWS_REGION)" >&2
  exit 1
fi

NOW_EPOCH="$(date +%s)"

echo "[aws-perf-cleanup] Region: $REGION"
echo "[aws-perf-cleanup] Now: $NOW_EPOCH"

candidate_ids="$(
  aws ec2 describe-instances \
    --region "$REGION" \
    --filters "Name=tag:Purpose,Values=perf-benchmark" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
    --query 'Reservations[].Instances[].{Id:InstanceId,Expiry:Tags[?Key==`ExpiresEpoch`]|[0].Value}' \
    --output text \
  | awk -v now="$NOW_EPOCH" 'NF>=2 { if ($2+0 <= now) print $1 }'
)"

if [[ -z "$candidate_ids" ]]; then
  echo "[aws-perf-cleanup] No stale perf instances found"
  exit 0
fi

echo "[aws-perf-cleanup] Terminating stale instances:"
echo "$candidate_ids" | sed 's/^/  - /'

aws ec2 terminate-instances --region "$REGION" --instance-ids $candidate_ids >/dev/null
echo "[aws-perf-cleanup] Terminate request submitted"
