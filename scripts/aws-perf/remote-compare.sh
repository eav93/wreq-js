#!/usr/bin/env bash
set -eEuo pipefail

require_env() {
  local key="$1"
  if [[ -z "${!key:-}" ]]; then
    echo "Missing required env: $key" >&2
    exit 1
  fi
}

require_env "REPO_URL"
require_env "BASE_REF"
require_env "HEAD_REF"
require_env "SCENARIOS"
require_env "DURATION_MS"
require_env "SAMPLES"
require_env "WARMUP"
require_env "CONCURRENCY"
require_env "THRESHOLD_PCT"

WORK_ROOT="${WORK_ROOT:-/tmp/wreq-perf-work}"
RESULT_DIR="${RESULT_DIR:-/tmp/wreq-perf-results}"
NODE_VERSION="${NODE_VERSION:-22.14.0}"

mkdir -p "$WORK_ROOT" "$RESULT_DIR"

log() {
  printf '[remote] %s\n' "$*"
}

dump_failure_context() {
  local exit_code=$?
  log "Command failed with exit code ${exit_code}. Dumping available logs from ${RESULT_DIR}:"

  local found=false
  for file in "$RESULT_DIR"/*.log; do
    if [[ -f "$file" ]]; then
      found=true
      echo "----- ${file} (tail) -----"
      tail -n 200 "$file" || true
    fi
  done

  if [[ "$found" == false ]]; then
    log "No log files found."
  fi

  exit "$exit_code"
}
trap dump_failure_context ERR

base64_encode_file() {
  local path="$1"
  if base64 --help 2>/dev/null | grep -q -- "-w"; then
    base64 -w 0 "$path"
  else
    base64 <"$path" | tr -d '\n'
  fi
}

install_system_packages() {
  if command -v dnf >/dev/null 2>&1; then
    log "Installing packages via dnf"
    dnf install -y git tar xz gzip gcc gcc-c++ make perl-core which cmake clang clang-libs util-linux >/dev/null
    return
  fi

  if command -v apt-get >/dev/null 2>&1; then
    log "Installing packages via apt-get"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y >/dev/null
    apt-get install -y git curl ca-certificates build-essential xz-utils cmake clang libclang-dev util-linux >/dev/null
    return
  fi

  echo "Unsupported package manager; need dnf or apt-get" >&2
  exit 1
}

detect_cpu_pinning() {
  SERVER_CPU=""
  BENCH_TASKSET=""

  if ! command -v taskset >/dev/null 2>&1; then
    log "taskset not available; skipping CPU pinning"
    return
  fi

  local ncpus
  ncpus="$(nproc 2>/dev/null || echo 1)"
  if [[ "$ncpus" -lt 4 ]]; then
    log "Only ${ncpus} CPUs available; skipping CPU pinning (need >= 4)"
    return
  fi

  SERVER_CPU="0"
  local last_cpu=$((ncpus - 1))
  BENCH_TASKSET="taskset -c 1-${last_cpu}"
  log "CPU pinning enabled: server on CPU ${SERVER_CPU}, bench on CPUs 1-${last_cpu}"
}

tune_cpu_for_benchmarking() {
  log "Tuning CPU for stable benchmarking"

  # Set CPU governor to performance (fixed frequency, no power-saving transitions)
  local tuned=0
  for gov in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
    if [[ -w "$gov" ]]; then
      echo performance > "$gov" 2>/dev/null && tuned=$((tuned + 1))
    fi
  done
  if [[ "$tuned" -gt 0 ]]; then
    log "Set CPU governor to 'performance' on ${tuned} cores"
  else
    log "Could not set CPU governor (no cpufreq sysfs or not writable)"
  fi

  # Disable Intel turbo boost (eliminates frequency variance between cores)
  if [[ -w /sys/devices/system/cpu/intel_pstate/no_turbo ]]; then
    echo 1 > /sys/devices/system/cpu/intel_pstate/no_turbo 2>/dev/null \
      && log "Disabled Intel turbo boost"
  elif [[ -w /sys/devices/system/cpu/cpufreq/boost ]]; then
    echo 0 > /sys/devices/system/cpu/cpufreq/boost 2>/dev/null \
      && log "Disabled AMD boost"
  fi

  # Stop irqbalance so IRQs don't migrate to benchmark cores mid-run
  if command -v systemctl >/dev/null 2>&1; then
    systemctl stop irqbalance 2>/dev/null \
      && log "Stopped irqbalance"
  fi
}

ensure_node() {
  local current_major=0

  if command -v node >/dev/null 2>&1; then
    current_major="$(node -p "process.versions.node.split('.')[0]" || echo 0)"
  fi

  if [[ "$current_major" -ge 20 ]]; then
    log "Node.js already present: $(node --version)"
    return
  fi

  local arch
  arch="$(uname -m)"
  local node_arch

  case "$arch" in
    x86_64) node_arch="x64" ;;
    aarch64) node_arch="arm64" ;;
    *)
      echo "Unsupported architecture for Node install: $arch" >&2
      exit 1
      ;;
  esac

  local tarball="/tmp/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"
  local prefix="/opt/node-v${NODE_VERSION}-linux-${node_arch}"

  log "Installing Node.js v${NODE_VERSION} (${node_arch})"
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" -o "$tarball"
  rm -rf "$prefix"
  tar -xJf "$tarball" -C /opt
  ln -sfn "$prefix" /opt/node
  ln -sfn /opt/node/bin/node /usr/local/bin/node
  ln -sfn /opt/node/bin/npm /usr/local/bin/npm
  ln -sfn /opt/node/bin/npx /usr/local/bin/npx
}

ensure_rust() {
  if command -v cargo >/dev/null 2>&1; then
    log "Rust already present: $(cargo --version)"
    return
  fi

  log "Installing Rust toolchain"
  curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal
}

source_rust_env() {
  export HOME="${HOME:-/root}"

  if [[ -f "/root/.cargo/env" ]]; then
    # shellcheck disable=SC1091
    source /root/.cargo/env
  fi
  if [[ -f "${HOME}/.cargo/env" ]]; then
    # shellcheck disable=SC1090
    source "${HOME}/.cargo/env"
  fi
}

normalize_repo_url() {
  local input="$1"
  if [[ "$input" =~ ^git@github\.com:(.+)\.git$ ]]; then
    printf 'https://github.com/%s.git\n' "${BASH_REMATCH[1]}"
    return
  fi
  printf '%s\n' "$input"
}

# Build shared bench infrastructure (runner code + Rust server binary).
# Sources come from the BENCH_OVERLAY_TAR sent by ec2-compare.sh (the
# caller's working tree), NOT from the cloned repo.  This means even when
# benchmarking old tags the Rust bench server and latest runner are used.
# Stored in BENCH_OVERLAY_DIR and copied into every commit dir by build_commit.
build_bench_overlay() {
  local overlay_dir="$BENCH_OVERLAY_DIR"
  local tmp_dir="$WORK_ROOT/_bench-overlay-build"

  rm -rf "$overlay_dir" "$tmp_dir"
  mkdir -p "$overlay_dir/src/bench" "$tmp_dir"

  # Extract bench files sent from the caller
  if [[ -n "${BENCH_OVERLAY_TAR:-}" && -f "$BENCH_OVERLAY_TAR" ]]; then
    tar -xf "$BENCH_OVERLAY_TAR" -C "$tmp_dir"
  else
    log "No bench overlay tar provided; both sides will use their own bench code"
    return
  fi

  # Copy bench runner source files
  if [[ -f "$tmp_dir/src/bench/run.ts" ]]; then
    cp -f "$tmp_dir/src/bench/run.ts" "$overlay_dir/src/bench/run.ts"
  fi
  if [[ -f "$tmp_dir/src/bench/local-bench-server.ts" ]]; then
    cp -f "$tmp_dir/src/bench/local-bench-server.ts" "$overlay_dir/src/bench/local-bench-server.ts"
  fi

  # Build Rust bench server binary from the extracted crate
  if [[ -f "$tmp_dir/rust/bench-server/Cargo.toml" ]]; then
    log "Building shared Rust bench server"
    local build_log="$RESULT_DIR/bench-server-build.log"
    if (
      cd "$tmp_dir"
      cargo build --release --manifest-path rust/bench-server/Cargo.toml >"$build_log" 2>&1
    ); then
      cp -f "$tmp_dir/rust/bench-server/target/release/wreq-bench-server" \
            "$overlay_dir/bench-server-binary"
      log "Rust bench server built successfully"
    else
      log "Rust bench server build failed; both sides will use Node.js server"
      echo "----- ${build_log} (tail) -----" >&2
      tail -n 50 "$build_log" >&2 || true
    fi
  else
    log "No bench server crate in overlay; both sides will use Node.js server"
  fi

  rm -rf "$tmp_dir"
}

# Build a commit into its own directory ready for benchmarking.
# Usage: build_commit <label> <ref> <source_repo>
build_commit() {
  local label="$1"
  local ref="$2"
  local source_repo="$3"
  local target_dir="$WORK_ROOT/$label"
  local build_log="$RESULT_DIR/${label}-build.log"

  log "Preparing ${label} directory"
  rm -rf "$target_dir"
  cp -a "$source_repo" "$target_dir"

  log "Checking out ${label} ref ${ref}"
  git -C "$target_dir" checkout --force "$ref" >/dev/null
  git -C "$target_dir" reset --hard "$ref" >/dev/null

  log "Installing npm dependencies for ${label}"
  if ! (
    cd "$target_dir"
    npm ci --no-audit --no-fund >"$RESULT_DIR/${label}-npm.log" 2>&1
  ); then
    echo "----- ${RESULT_DIR}/${label}-npm.log (tail) -----" >&2
    tail -n 200 "$RESULT_DIR/${label}-npm.log" >&2 || true
    return 1
  fi

  log "Building native module for ${label}"
  if ! (
    cd "$target_dir"
    npm run build:rust >"$build_log" 2>&1
  ); then
    echo "----- ${build_log} (tail) -----" >&2
    tail -n 200 "$build_log" >&2 || true
    return 1
  fi

  # Overlay shared bench infrastructure (runner + server) from HEAD so that
  # every commit — even old ones — uses the same Rust bench server and the
  # same measurement code.  Only the native module under test differs.
  if [[ -n "${BENCH_OVERLAY_DIR:-}" && -d "$BENCH_OVERLAY_DIR" ]]; then
    log "Overlaying shared bench infra onto ${label}"
    cp -f "$BENCH_OVERLAY_DIR/src/bench/run.ts"               "$target_dir/src/bench/run.ts"
    cp -f "$BENCH_OVERLAY_DIR/src/bench/local-bench-server.ts" "$target_dir/src/bench/local-bench-server.ts"
    if [[ -f "$BENCH_OVERLAY_DIR/bench-server-binary" ]]; then
      mkdir -p "$target_dir/rust/bench-server/target/release"
      cp -f "$BENCH_OVERLAY_DIR/bench-server-binary" \
            "$target_dir/rust/bench-server/target/release/wreq-bench-server"
    fi
  fi
}

# Run a single scenario against a pre-built commit directory.
# Usage: run_scenario <label> <scenario>
run_scenario() {
  local label="$1"
  local scenario="$2"
  local work_dir="$WORK_ROOT/$label"
  local json_out="$RESULT_DIR/${label}--${scenario}.json"
  local bench_log="$RESULT_DIR/${label}--${scenario}-bench.log"

  local -a bench_args
  bench_args=(
    "--duration-ms" "$DURATION_MS"
    "--samples" "$SAMPLES"
    "--warmup" "$WARMUP"
    "--concurrency" "$CONCURRENCY"
    "--scenario" "$scenario"
    "--json" "$json_out"
  )

  log "Running ${label} / ${scenario}"
  if ! (
    cd "$work_dir"
    export BENCH_SERVER_CPU="${SERVER_CPU:-}"
    ${BENCH_TASKSET:-} npm run bench:run -- "${bench_args[@]}" >"$bench_log" 2>&1
  ); then
    echo "----- ${bench_log} (tail) -----" >&2
    tail -n 200 "$bench_log" >&2 || true
    return 1
  fi
}

# Merge per-scenario JSON files into a single combined result file.
# Usage: merge_results <label>
merge_results() {
  local label="$1"
  local merged="$RESULT_DIR/${label}.json"

  node - "$label" "$RESULT_DIR" "$merged" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const label = process.argv[2];
const resultDir = process.argv[3];
const outPath = process.argv[4];

const prefix = `${label}--`;
const files = fs.readdirSync(resultDir)
  .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
  .sort();

if (files.length === 0) {
  console.error(`No scenario result files found for label: ${label}`);
  process.exit(1);
}

// Use metadata from the first file as the base
const first = JSON.parse(fs.readFileSync(path.join(resultDir, files[0]), "utf8"));
const merged = {
  startedAt: first.startedAt,
  git: first.git,
  env: first.env,
  config: first.config,
  server: first.server,
  results: [],
};

for (const file of files) {
  const data = JSON.parse(fs.readFileSync(path.join(resultDir, file), "utf8"));
  merged.results.push(...data.results);
}

fs.writeFileSync(outPath, JSON.stringify(merged, null, 2));
NODE
}

main() {
  install_system_packages
  ensure_node
  ensure_rust
  source_rust_env
  detect_cpu_pinning
  tune_cpu_for_benchmarking

  local normalized_repo_url
  normalized_repo_url="$(normalize_repo_url "$REPO_URL")"

  local repo_dir="$WORK_ROOT/repo"
  rm -rf "$repo_dir"

  log "Cloning repository"
  git clone --filter=blob:none "$normalized_repo_url" "$repo_dir" >"$RESULT_DIR/git-clone.log" 2>&1
  git -C "$repo_dir" fetch --all --tags --prune >/dev/null

  if ! git -C "$repo_dir" rev-parse --verify "${BASE_REF}^{commit}" >/dev/null 2>&1; then
    echo "Base ref not found in remote clone: $BASE_REF" >&2
    exit 1
  fi

  if ! git -C "$repo_dir" rev-parse --verify "${HEAD_REF}^{commit}" >/dev/null 2>&1; then
    echo "Head ref not found in remote clone: $HEAD_REF" >&2
    exit 1
  fi

  # Materialize blobs for both refs before copying
  git -C "$repo_dir" checkout --force "$BASE_REF" >/dev/null
  git -C "$repo_dir" checkout --force "$HEAD_REF" >/dev/null

  # Build shared bench infrastructure from the overlay tar sent by
  # ec2-compare.sh (the caller's working tree).  The bench runner and
  # bench server are test infra, not code-under-test, so both BASE and
  # HEAD must share the same version for a fair comparison.
  BENCH_OVERLAY_DIR="$WORK_ROOT/bench-overlay"
  export BENCH_OVERLAY_DIR
  build_bench_overlay

  # Build both commits into separate directories
  build_commit "base" "$BASE_REF" "$repo_dir"
  build_commit "head" "$HEAD_REF" "$repo_dir"

  # Interleaved A/B: for each scenario, run base then head back-to-back.
  # This ensures system state (thermal, caches, scheduling) is matched
  # per-scenario rather than accumulating drift across all scenarios.
  IFS=';' read -r -a scenario_array <<< "$SCENARIOS"
  for scenario in "${scenario_array[@]}"; do
    [[ -n "$scenario" ]] || continue
    log "=== Interleaved pair: ${scenario} ==="
    run_scenario "base" "$scenario"
    run_scenario "head" "$scenario"
  done

  # Merge per-scenario results into base.json / head.json
  merge_results "base"
  merge_results "head"

  log "Generating comparison report"
  node - "$RESULT_DIR/base.json" "$RESULT_DIR/head.json" "$THRESHOLD_PCT" "$RESULT_DIR/report.md" "$RESULT_DIR/report.json" >"$RESULT_DIR/compare.log" 2>&1 <<'NODE'
const fs = require("node:fs");

const basePath = process.argv[2];
const headPath = process.argv[3];
const thresholdPct = Number(process.argv[4]);
const markdownPath = process.argv[5];
const jsonPath = process.argv[6];

const baseRun = JSON.parse(fs.readFileSync(basePath, "utf8"));
const headRun = JSON.parse(fs.readFileSync(headPath, "utf8"));

const baseMap = new Map(baseRun.results.map((result) => [result.name, result]));
const headMap = new Map(headRun.results.map((result) => [result.name, result]));

const names = [...baseMap.keys()].filter((name) => headMap.has(name)).sort();
const scenarios = names.map((name) => {
  const base = baseMap.get(name);
  const head = headMap.get(name);
  const deltaPct = ((head.mean - base.mean) / base.mean) * 100;
  const deltaBestPct = base.max > 0 ? ((head.max - base.max) / base.max) * 100 : deltaPct;
  const regression = deltaPct <= -thresholdPct;
  const improvement = deltaPct >= thresholdPct;
  return {
    name,
    baseMean: base.mean,
    headMean: head.mean,
    baseMax: base.max,
    headMax: head.max,
    deltaPct,
    deltaBestPct,
    baseCiPct: base.ci95.marginPct,
    headCiPct: head.ci95.marginPct,
    status: regression ? "REGRESSION" : improvement ? "IMPROVEMENT" : "OK",
  };
});

const regressions = scenarios.filter((item) => item.status === "REGRESSION").map((item) => item.name);
const report = {
  generatedAt: new Date().toISOString(),
  thresholdPct,
  baseCommit: baseRun.git?.commit,
  headCommit: headRun.git?.commit,
  baseServerKind: baseRun.server?.kind || "unknown",
  headServerKind: headRun.server?.kind || "unknown",
  regressions,
  pass: regressions.length === 0,
  scenarios,
};

const num = (value) => value.toLocaleString("en-US", { maximumFractionDigits: 2 });
const pct = (value) => `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;

const lines = [];
lines.push("# AWS Perf Compare");
lines.push("");
lines.push(`- Generated: ${report.generatedAt}`);
lines.push(`- Threshold: ${report.thresholdPct}% throughput drop => regression`);
if (report.baseCommit) lines.push(`- Base commit: ${report.baseCommit}`);
if (report.headCommit) lines.push(`- Head commit: ${report.headCommit}`);
lines.push(`- Server: base=${report.baseServerKind}, head=${report.headServerKind}`);
lines.push("");
lines.push("| Scenario | Base mean | Head mean | Delta | Best-of base | Best-of head | Delta (best) | Status | Base CI | Head CI |");
lines.push("|---|---:|---:|---:|---:|---:|---:|---|---:|---:|");
for (const row of scenarios) {
  lines.push(
    `| ${row.name} | ${num(row.baseMean)} | ${num(row.headMean)} | ${pct(row.deltaPct)} | ${num(row.baseMax)} | ${num(row.headMax)} | ${pct(row.deltaBestPct)} | ${row.status} | ±${row.baseCiPct.toFixed(2)}% | ±${row.headCiPct.toFixed(2)}% |`,
  );
}
lines.push("");
lines.push(`## Gate: ${report.pass ? "PASS" : "FAIL"}`);
if (!report.pass) {
  lines.push(`Regressions: ${report.regressions.join(", ")}`);
}

const markdown = lines.join("\n");
fs.writeFileSync(markdownPath, markdown, "utf8");
fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf8");
NODE

  cat "$RESULT_DIR/report.md"
  echo ""
  echo "__WREQ_PERF_SUMMARY_B64__$(base64_encode_file "$RESULT_DIR/report.json")"
}

main
