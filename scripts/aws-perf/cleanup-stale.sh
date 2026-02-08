#!/usr/bin/env bash
set -euo pipefail

DEFAULT_REGION="us-west-2"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-$DEFAULT_REGION}}"
POSITIONAL_REGION=""

usage() {
  cat <<'EOF'
Usage: scripts/aws-perf/cleanup-stale.sh [options] [region]

Options:
  --region <aws-region>   AWS region (default: us-west-2)
  -h, --help              Show help

Examples:
  scripts/aws-perf/cleanup-stale.sh
  scripts/aws-perf/cleanup-stale.sh --region us-west-2
  scripts/aws-perf/cleanup-stale.sh us-west-2
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --region)
      if [[ $# -lt 2 ]]; then
        echo "[aws-perf-cleanup] ERROR: --region requires a value" >&2
        usage
        exit 1
      fi
      REGION="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --*)
      echo "[aws-perf-cleanup] ERROR: unknown argument: $1" >&2
      usage
      exit 1
      ;;
    *)
      POSITIONAL_REGION="$1"
      shift
      ;;
  esac
done

if [[ -n "$POSITIONAL_REGION" ]]; then
  REGION="$POSITIONAL_REGION"
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
