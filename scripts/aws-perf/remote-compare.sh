#!/usr/bin/env bash
set -euo pipefail

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

base64_encode_file() {
  local path="$1"
  if base64 --help 2>/dev/null | grep -q -- "-w"; then
    base64 -w 0 "$path"
  else
    base64 "$path" | tr -d '\n'
  fi
}

install_system_packages() {
  if command -v dnf >/dev/null 2>&1; then
    log "Installing packages via dnf"
    dnf install -y git curl tar xz gzip gcc gcc-c++ make perl-core which >/dev/null
    return
  fi

  if command -v apt-get >/dev/null 2>&1; then
    log "Installing packages via apt-get"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y >/dev/null
    apt-get install -y git curl ca-certificates build-essential xz-utils >/dev/null
    return
  fi

  echo "Unsupported package manager; need dnf or apt-get" >&2
  exit 1
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
  if [[ -f "/root/.cargo/env" ]]; then
    # shellcheck disable=SC1091
    source /root/.cargo/env
  fi
  if [[ -f "$HOME/.cargo/env" ]]; then
    # shellcheck disable=SC1090
    source "$HOME/.cargo/env"
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

run_bench() {
  local label="$1"
  local ref="$2"
  local repo_dir="$3"
  local json_out="$RESULT_DIR/${label}.json"
  local build_log="$RESULT_DIR/${label}-build.log"
  local bench_log="$RESULT_DIR/${label}-bench.log"

  log "Checking out ${label} ref ${ref}"
  git -C "$repo_dir" checkout --force "$ref" >/dev/null
  git -C "$repo_dir" reset --hard "$ref" >/dev/null

  log "Installing npm dependencies for ${label}"
  (
    cd "$repo_dir"
    npm ci --no-audit --no-fund >"$RESULT_DIR/${label}-npm.log" 2>&1
  )

  log "Building native module for ${label}"
  (
    cd "$repo_dir"
    npm run build:rust >"$build_log" 2>&1
  )

  local -a bench_args
  bench_args=(
    "--duration-ms" "$DURATION_MS"
    "--samples" "$SAMPLES"
    "--warmup" "$WARMUP"
    "--concurrency" "$CONCURRENCY"
  )

  IFS=';' read -r -a scenario_array <<< "$SCENARIOS"
  for scenario in "${scenario_array[@]}"; do
    if [[ -n "$scenario" ]]; then
      bench_args+=("--scenario" "$scenario")
    fi
  done

  bench_args+=("--json" "$json_out")

  log "Running benchmark ${label}"
  (
    cd "$repo_dir"
    npm run bench:run -- "${bench_args[@]}" >"$bench_log" 2>&1
  )
}

main() {
  install_system_packages
  ensure_node
  ensure_rust
  source_rust_env

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

  run_bench "base" "$BASE_REF" "$repo_dir"
  run_bench "head" "$HEAD_REF" "$repo_dir"

  log "Generating comparison report"
  (
    cd "$repo_dir"
    node scripts/aws-perf/compare-bench.mjs \
      --base "$RESULT_DIR/base.json" \
      --head "$RESULT_DIR/head.json" \
      --threshold-pct "$THRESHOLD_PCT" \
      --markdown "$RESULT_DIR/report.md" \
      --json "$RESULT_DIR/report.json" \
      --no-fail >"$RESULT_DIR/compare.log" 2>&1
  )

  cat "$RESULT_DIR/report.md"
  echo ""
  echo "__WREQ_PERF_SUMMARY_B64__$(base64_encode_file "$RESULT_DIR/report.json")"
}

main
