#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

RUN_ID="wreq-perf-$(date -u +%Y%m%dT%H%M%SZ)"
INSTANCE_ID=""
SHOULD_CLEANUP=true
PARAMS_FILE=""

DEFAULT_REGION="us-west-2"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-$DEFAULT_REGION}}"
INSTANCE_PROFILE_NAME="wreq-js-perf-ssm-profile"
INSTANCE_TYPE="c6i.xlarge"
AUTO_CHEAPEST_REGION=false
PRICING_ONLY=false
USE_SPOT=true
FALLBACK_ON_DEMAND=true
SUBNET_ID=""
SECURITY_GROUP_ID=""
BASE_REF="$(git -C "$ROOT_DIR" rev-parse HEAD~1)"
HEAD_REF="$(git -C "$ROOT_DIR" rev-parse HEAD)"
REPO_URL="$(git -C "$ROOT_DIR" remote get-url origin)"
TTL_HOURS=2
THRESHOLD_PCT=5
DURATION_MS=3000
SAMPLES=15
WARMUP=3
CONCURRENCY=16
SCENARIOS="wreq.session.get.small;wreq.transport.get.small;wreq.session.get.4kb;wreq.session.post.32b;wreq.isolated.get.small;node.fetch.get.small"
OUTPUT_DIR="$ROOT_DIR/tmp/aws-perf/$RUN_ID"
PRICING_JSON=""
CHEAPEST_REPORT_PATH=""

usage() {
  cat <<'EOF'
Usage: scripts/aws-perf/ec2-compare.sh [options]

Options:
  --region <aws-region>             AWS region (default: us-west-2)
  --cheapest-region                 Auto-select cheapest on-demand region for instance type
  --instance-profile <name>         IAM instance profile with AmazonSSMManagedInstanceCore
  --instance-type <type>            EC2 instance type (default: c6i.large)
  --subnet-id <subnet-id>           Optional; auto-detected when omitted
  --security-group-id <sg-id>       Optional; auto-detected default SG when omitted
  --base-ref <git-ref>              Base commit/ref (default: HEAD~1)
  --head-ref <git-ref>              Head commit/ref (default: HEAD)
  --repo-url <git-url>              Repo URL to clone on EC2 (default: origin URL)
  --duration-ms <n>                 Benchmark sample duration
  --samples <n>                     Number of samples
  --warmup <n>                      Warmup samples
  --concurrency <n>                 Concurrent workers
  --scenarios <a;b;c>               Semicolon-separated scenarios
  --threshold-pct <n>               Throughput drop threshold for regression (default: 5)
  --ttl-hours <n>                   Auto-expiry tag horizon (default: 2)
  --output-dir <path>               Local output directory
  --pricing-only                    Print pricing info and exit without launching EC2
  --on-demand                        Disable Spot and use on-demand instance
  --no-fallback-on-demand            Do not retry on-demand when Spot launch fails
  --keep-instance                    Do not terminate instance after run
  -h, --help                         Show help
EOF
}

log() {
  printf '[aws-perf] %s\n' "$*"
}

shell_quote() {
  printf '%q' "$1"
}

fail() {
  printf '[aws-perf] ERROR: %s\n' "$*" >&2
  exit 1
}

requires() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

base64_decode_to_file() {
  local destination="$1"
  if base64 --help 2>/dev/null | grep -q -- "-d"; then
    base64 -d >"$destination"
  else
    base64 -D >"$destination"
  fi
}

base64_encode_file() {
  local path="$1"
  if base64 --help 2>/dev/null | grep -q -- "-w"; then
    base64 -w 0 "$path"
  else
    base64 <"$path" | tr -d '\n'
  fi
}

pricing_script_path() {
  printf '%s/pricing-info.mjs' "$SCRIPT_DIR"
}

resolve_cheapest_region() {
  local pricing_script="$1"
  local report_path="$2"

  node "$pricing_script" --instance-type "$INSTANCE_TYPE" --region "$REGION" --cheapest >"$report_path"

  local cheapest_region
  cheapest_region="$(node - "$report_path" <<'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
process.stdout.write(report.cheapestOnDemand?.regionCode || "");
NODE
)"

  [[ -n "$cheapest_region" ]] || fail "Unable to determine cheapest region for instance type: $INSTANCE_TYPE"

  local cheapest_details
  cheapest_details="$(node - "$report_path" <<'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const cheapest = report.cheapestOnDemand;
if (!cheapest) {
  process.exit(1);
}
const usd = Number(cheapest.usdPerHour);
const rate = Number.isFinite(usd) ? usd.toFixed(4) : "n/a";
process.stdout.write(`${cheapest.regionCode}|${cheapest.location || "unknown"}|${rate}`);
NODE
)"

  local cheapest_code cheapest_location cheapest_rate
  IFS='|' read -r cheapest_code cheapest_location cheapest_rate <<<"$cheapest_details"
  log "Cheapest on-demand region for $INSTANCE_TYPE: $cheapest_code ($cheapest_location) at \$$cheapest_rate/hour"
  REGION="$cheapest_region"
}

collect_pricing_report() {
  local pricing_script="$1"
  local report_path="$2"
  node "$pricing_script" --instance-type "$INSTANCE_TYPE" --region "$REGION" >"$report_path"
}

merge_pricing_reports() {
  local selected_path="$1"
  local cheapest_path="$2"
  node - "$selected_path" "$cheapest_path" <<'NODE'
const fs = require("node:fs");
const selectedPath = process.argv[2];
const cheapestPath = process.argv[3];

const selected = JSON.parse(fs.readFileSync(selectedPath, "utf8"));
const cheapest = JSON.parse(fs.readFileSync(cheapestPath, "utf8"));

selected.cheapestOnDemand = cheapest.cheapestOnDemand || null;
selected.topOnDemand = cheapest.topOnDemand || [];
selected.regionCountSampled = cheapest.regionCountSampled || 0;

fs.writeFileSync(selectedPath, JSON.stringify(selected, null, 2));
NODE
}

print_pricing_summary() {
  local report_path="$1"
  while IFS= read -r line; do
    log "$line"
  done < <(
    node - "$report_path" <<'NODE'
const fs = require("node:fs");
const report = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));

const onDemand = report.selectedOnDemand;
if (onDemand) {
  console.log(
    `Pricing selected region: ${onDemand.regionCode} (${onDemand.location || "unknown"}) at $${Number(onDemand.usdPerHour).toFixed(4)}/hour on-demand`,
  );
} else {
  console.log(`Pricing selected region: ${report.selectedRegion} (on-demand price unavailable)`);
}

const spot = report.selectedSpot24h;
if (spot) {
  console.log(
    `Spot (last ${spot.windowHours}h): avg $${Number(spot.avgUsdPerHour).toFixed(4)}/hour, min $${Number(spot.minUsdPerHour).toFixed(4)}, max $${Number(spot.maxUsdPerHour).toFixed(4)}, samples ${spot.samples}`,
  );
}

if (report.cheapestOnDemand) {
  const c = report.cheapestOnDemand;
  console.log(
    `Cheapest on-demand sampled: ${c.regionCode} (${c.location || "unknown"}) at $${Number(c.usdPerHour).toFixed(4)}/hour`,
  );
}
NODE
  )
}

cleanup() {
  if [[ -n "$CHEAPEST_REPORT_PATH" ]]; then
    rm -f "$CHEAPEST_REPORT_PATH" || true
  fi

  if [[ -n "$PARAMS_FILE" ]]; then
    rm -f "$PARAMS_FILE" || true
  fi

  if [[ -n "$INSTANCE_ID" && "$SHOULD_CLEANUP" == true ]]; then
    log "Terminating instance $INSTANCE_ID"
    aws ec2 terminate-instances --region "$REGION" --instance-ids "$INSTANCE_ID" >/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

while [[ $# -gt 0 ]]; do
  case "$1" in
    --region) REGION="$2"; shift 2 ;;
    --cheapest-region) AUTO_CHEAPEST_REGION=true; shift ;;
    --instance-profile) INSTANCE_PROFILE_NAME="$2"; shift 2 ;;
    --instance-type) INSTANCE_TYPE="$2"; shift 2 ;;
    --subnet-id) SUBNET_ID="$2"; shift 2 ;;
    --security-group-id) SECURITY_GROUP_ID="$2"; shift 2 ;;
    --base-ref) BASE_REF="$2"; shift 2 ;;
    --head-ref) HEAD_REF="$2"; shift 2 ;;
    --repo-url) REPO_URL="$2"; shift 2 ;;
    --duration-ms) DURATION_MS="$2"; shift 2 ;;
    --samples) SAMPLES="$2"; shift 2 ;;
    --warmup) WARMUP="$2"; shift 2 ;;
    --concurrency) CONCURRENCY="$2"; shift 2 ;;
    --scenarios) SCENARIOS="$2"; shift 2 ;;
    --threshold-pct) THRESHOLD_PCT="$2"; shift 2 ;;
    --ttl-hours) TTL_HOURS="$2"; shift 2 ;;
    --output-dir) OUTPUT_DIR="$2"; shift 2 ;;
    --pricing-only) PRICING_ONLY=true; shift ;;
    --on-demand) USE_SPOT=false; shift ;;
    --no-fallback-on-demand) FALLBACK_ON_DEMAND=false; shift ;;
    --keep-instance) SHOULD_CLEANUP=false; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Unknown argument: $1" ;;
  esac
done

requires aws
requires git
requires sed
requires grep
requires mktemp
requires node

[[ -n "$REGION" ]] || fail "AWS region is required (use --region or set AWS_REGION)"
[[ -n "$INSTANCE_TYPE" ]] || fail "Instance type is required"

if [[ "$AUTO_CHEAPEST_REGION" == true ]] && [[ -n "$SUBNET_ID" || -n "$SECURITY_GROUP_ID" ]]; then
  fail "--cheapest-region cannot be combined with --subnet-id or --security-group-id"
fi

mkdir -p "$OUTPUT_DIR"
PRICING_JSON="$OUTPUT_DIR/pricing.json"

PRICING_SCRIPT="$(pricing_script_path)"
[[ -f "$PRICING_SCRIPT" ]] || fail "Missing pricing helper script: $PRICING_SCRIPT"

if [[ "$AUTO_CHEAPEST_REGION" == true ]]; then
  CHEAPEST_REPORT_PATH="$(mktemp)"
  log "Detecting cheapest on-demand region for instance type: $INSTANCE_TYPE"
  resolve_cheapest_region "$PRICING_SCRIPT" "$CHEAPEST_REPORT_PATH"
fi

collect_pricing_report "$PRICING_SCRIPT" "$PRICING_JSON"

if [[ -n "$CHEAPEST_REPORT_PATH" ]]; then
  merge_pricing_reports "$PRICING_JSON" "$CHEAPEST_REPORT_PATH"
  rm -f "$CHEAPEST_REPORT_PATH" || true
fi

print_pricing_summary "$PRICING_JSON"
log "Pricing report: $PRICING_JSON"

if [[ "$PRICING_ONLY" == true ]]; then
  log "Pricing-only mode enabled; exiting without launching EC2"
  exit 0
fi

log "Resolving refs"
BASE_REF="$(git -C "$ROOT_DIR" rev-parse "$BASE_REF")"
HEAD_REF="$(git -C "$ROOT_DIR" rev-parse "$HEAD_REF")"

log "Validating AWS identity"
aws sts get-caller-identity --region "$REGION" >/dev/null

if [[ -z "$SUBNET_ID" ]]; then
  log "Auto-detecting default subnet"
  SUBNET_ID="$(aws ec2 describe-subnets \
    --region "$REGION" \
    --filters "Name=default-for-az,Values=true" "Name=state,Values=available" \
    --query 'Subnets[0].SubnetId' \
    --output text)"
fi
[[ -n "$SUBNET_ID" && "$SUBNET_ID" != "None" ]] || fail "Could not determine subnet. Pass --subnet-id explicitly."

if [[ -z "$SECURITY_GROUP_ID" ]]; then
  log "Auto-detecting default security group"
  VPC_ID="$(aws ec2 describe-subnets --region "$REGION" --subnet-ids "$SUBNET_ID" --query 'Subnets[0].VpcId' --output text)"
  SECURITY_GROUP_ID="$(aws ec2 describe-security-groups \
    --region "$REGION" \
    --filters "Name=vpc-id,Values=$VPC_ID" "Name=group-name,Values=default" \
    --query 'SecurityGroups[0].GroupId' \
    --output text)"
fi
[[ -n "$SECURITY_GROUP_ID" && "$SECURITY_GROUP_ID" != "None" ]] || fail "Could not determine security group. Pass --security-group-id explicitly."

AMI_ID="$(aws ssm get-parameter \
  --region "$REGION" \
  --name "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64" \
  --query 'Parameter.Value' \
  --output text)"

[[ -n "$AMI_ID" && "$AMI_ID" != "None" ]] || fail "Failed to resolve Amazon Linux 2023 AMI"

EXPIRY_EPOCH="$(( $(date +%s) + TTL_HOURS * 3600 ))"

launch_instance() {
  local market="$1"

  if [[ "$market" == "spot" ]]; then
    aws ec2 run-instances \
      --region "$REGION" \
      --image-id "$AMI_ID" \
      --instance-type "$INSTANCE_TYPE" \
      --subnet-id "$SUBNET_ID" \
      --security-group-ids "$SECURITY_GROUP_ID" \
      --iam-instance-profile "Name=$INSTANCE_PROFILE_NAME" \
      --block-device-mappings 'DeviceName=/dev/xvda,Ebs={VolumeSize=25,VolumeType=gp3,DeleteOnTermination=true}' \
      --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$RUN_ID},{Key=Project,Value=wreq-js},{Key=Purpose,Value=perf-benchmark},{Key=RunId,Value=$RUN_ID},{Key=ExpiresEpoch,Value=$EXPIRY_EPOCH}]" \
      --instance-market-options "MarketType=spot,SpotOptions={SpotInstanceType=one-time,InstanceInterruptionBehavior=terminate}" \
      --query 'Instances[0].InstanceId' \
      --output text
    return
  fi

  aws ec2 run-instances \
    --region "$REGION" \
    --image-id "$AMI_ID" \
    --instance-type "$INSTANCE_TYPE" \
    --subnet-id "$SUBNET_ID" \
    --security-group-ids "$SECURITY_GROUP_ID" \
    --iam-instance-profile "Name=$INSTANCE_PROFILE_NAME" \
    --block-device-mappings 'DeviceName=/dev/xvda,Ebs={VolumeSize=25,VolumeType=gp3,DeleteOnTermination=true}' \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$RUN_ID},{Key=Project,Value=wreq-js},{Key=Purpose,Value=perf-benchmark},{Key=RunId,Value=$RUN_ID},{Key=ExpiresEpoch,Value=$EXPIRY_EPOCH}]" \
    --query 'Instances[0].InstanceId' \
    --output text
}

if [[ "$USE_SPOT" == true ]]; then
  log "Launching Spot instance"
  if ! INSTANCE_ID="$(launch_instance spot 2>/tmp/wreq-spot-launch.err)"; then
    if [[ "$FALLBACK_ON_DEMAND" == true ]]; then
      log "Spot launch failed; falling back to on-demand"
      INSTANCE_ID="$(launch_instance on-demand)"
    else
      cat /tmp/wreq-spot-launch.err >&2 || true
      fail "Spot launch failed and fallback disabled"
    fi
  fi
else
  log "Launching on-demand instance"
  INSTANCE_ID="$(launch_instance on-demand)"
fi

[[ -n "$INSTANCE_ID" && "$INSTANCE_ID" != "None" ]] || fail "Failed to launch instance"
log "Launched instance: $INSTANCE_ID"

log "Waiting for EC2 running state"
aws ec2 wait instance-running --region "$REGION" --instance-ids "$INSTANCE_ID"

log "Waiting for SSM agent online"
for _ in $(seq 1 90); do
  ping_status="$(aws ssm describe-instance-information \
    --region "$REGION" \
    --filters "Key=InstanceIds,Values=$INSTANCE_ID" \
    --query 'InstanceInformationList[0].PingStatus' \
    --output text 2>/dev/null || true)"
  if [[ "$ping_status" == "Online" ]]; then
    break
  fi
  sleep 5
done

if [[ "$ping_status" != "Online" ]]; then
  fail "Instance did not become SSM-online in time"
fi

REMOTE_SCRIPT_B64="$(base64_encode_file "$SCRIPT_DIR/remote-compare.sh")"

# Bundle bench overlay: the bench runner TS files + Rust bench server crate.
# These are sent to EC2 so every commit (even old ones) uses the same bench
# infrastructure from the current working tree.
BENCH_OVERLAY_TAR="$(mktemp)"
log "Packaging bench overlay from local tree"
tar -cf "$BENCH_OVERLAY_TAR" \
  -C "$ROOT_DIR" \
  src/bench/run.ts \
  src/bench/local-bench-server.ts \
  rust/bench-server/Cargo.toml \
  rust/bench-server/src/main.rs \
  2>/dev/null || true
BENCH_OVERLAY_B64="$(base64_encode_file "$BENCH_OVERLAY_TAR")"
rm -f "$BENCH_OVERLAY_TAR"

run_command="BASE_REF=$(shell_quote "$BASE_REF") \
HEAD_REF=$(shell_quote "$HEAD_REF") \
REPO_URL=$(shell_quote "$REPO_URL") \
SCENARIOS=$(shell_quote "$SCENARIOS") \
DURATION_MS=$(shell_quote "$DURATION_MS") \
SAMPLES=$(shell_quote "$SAMPLES") \
WARMUP=$(shell_quote "$WARMUP") \
CONCURRENCY=$(shell_quote "$CONCURRENCY") \
THRESHOLD_PCT=$(shell_quote "$THRESHOLD_PCT") \
BENCH_OVERLAY_TAR=/tmp/wreq-bench-overlay.tar \
bash /tmp/wreq-remote-compare.sh"

PARAMS_FILE="$(mktemp)"

node - "$PARAMS_FILE" "$REMOTE_SCRIPT_B64" "$BENCH_OVERLAY_B64" "$run_command" <<'NODE'
const fs = require("node:fs");
const paramsPath = process.argv[2];
const scriptB64 = process.argv[3];
const overlayB64 = process.argv[4];
const runCommand = process.argv[5];
const params = {
  commands: [
    "set -euo pipefail",
    `echo '${scriptB64}' | base64 -d >/tmp/wreq-remote-compare.sh`,
    "chmod +x /tmp/wreq-remote-compare.sh",
    `echo '${overlayB64}' | base64 -d >/tmp/wreq-bench-overlay.tar`,
    runCommand,
  ],
};
fs.writeFileSync(paramsPath, JSON.stringify(params));
NODE

COMMAND_ID="$(aws ssm send-command \
  --region "$REGION" \
  --document-name "AWS-RunShellScript" \
  --instance-ids "$INSTANCE_ID" \
  --comment "wreq-js perf compare $RUN_ID" \
  --timeout-seconds 7200 \
  --parameters "file://$PARAMS_FILE" \
  --query 'Command.CommandId' \
  --output text)"

[[ -n "$COMMAND_ID" && "$COMMAND_ID" != "None" ]] || fail "Failed to start SSM command"
log "Started SSM command: $COMMAND_ID"

status="Pending"
for _ in $(seq 1 720); do
  status="$(aws ssm get-command-invocation \
    --region "$REGION" \
    --command-id "$COMMAND_ID" \
    --instance-id "$INSTANCE_ID" \
    --query 'Status' \
    --output text 2>/dev/null || true)"

  case "$status" in
    Success|Failed|Cancelled|TimedOut|Undeliverable|Terminated)
      break
      ;;
  esac
  sleep 5
done

STDOUT_PATH="$OUTPUT_DIR/ssm-stdout.log"
STDERR_PATH="$OUTPUT_DIR/ssm-stderr.log"

aws ssm get-command-invocation \
  --region "$REGION" \
  --command-id "$COMMAND_ID" \
  --instance-id "$INSTANCE_ID" \
  --query 'StandardOutputContent' \
  --output text >"$STDOUT_PATH" || true

aws ssm get-command-invocation \
  --region "$REGION" \
  --command-id "$COMMAND_ID" \
  --instance-id "$INSTANCE_ID" \
  --query 'StandardErrorContent' \
  --output text >"$STDERR_PATH" || true

if [[ "$status" != "Success" ]]; then
  log "Remote command failed with status: $status"
  cat "$STDERR_PATH" >&2 || true
  fail "Benchmark run failed"
fi

summary_b64="$(sed -n 's/^__WREQ_PERF_SUMMARY_B64__//p' "$STDOUT_PATH" | tail -n 1)"
[[ -n "$summary_b64" ]] || fail "Summary marker not found in remote output"

SUMMARY_JSON="$OUTPUT_DIR/summary.json"
printf '%s' "$summary_b64" | base64_decode_to_file "$SUMMARY_JSON"

node - "$SUMMARY_JSON" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
const report = JSON.parse(fs.readFileSync(path, "utf8"));
console.log("");
console.log("Perf gate:", report.pass ? "PASS" : "FAIL");
for (const scenario of report.scenarios) {
  const delta = scenario.deltaPct.toFixed(2);
  console.log(`${scenario.status.padEnd(11)} ${scenario.name.padEnd(28)} ${delta}%`);
}
NODE

if [[ "$SHOULD_CLEANUP" == false ]]; then
  log "Instance kept alive per --keep-instance: $INSTANCE_ID"
fi

if node -e 'const fs=require("node:fs"); const report=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.exit(report.pass ? 0 : 2);' "$SUMMARY_JSON"; then
  log "Regression gate passed"
else
  fail "Regression gate failed (see $SUMMARY_JSON)"
fi
