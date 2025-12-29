import { writeFile } from "node:fs/promises";
import os from "node:os";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { createSession, createTransport, fetch as wreqFetch } from "../wreq-js.js";
import { startLocalBenchServer } from "./local-bench-server.js";

type ScenarioResult = {
  name: string;
  unit: "req/s";
  samples: number[];
  mean: number;
  stdev: number;
  cv: number;
  ci95: { low: number; high: number; margin: number; marginPct: number };
  min: number;
  max: number;
  errors: number;
};

type BenchRun = {
  startedAt: string;
  git?: { commit?: string };
  env: {
    node: string;
    platform: string;
    arch: string;
    cpus: { model: string; speed: number; cores: number };
  };
  config: {
    durationMs: number;
    samples: number;
    warmup: number;
    concurrency: number;
  };
  server: { baseUrl: string };
  results: ScenarioResult[];
};

type Args = {
  durationMs: number;
  samples: number;
  warmup: number;
  concurrency: number;
  scenarios: string[] | null;
  jsonPath: string | null;
};

const DEFAULT_CONCURRENCY = Math.min(64, Math.max(8, os.cpus().length * 2));

const DEFAULTS: Args = {
  durationMs: 3000,
  samples: 20,
  warmup: 5,
  concurrency: DEFAULT_CONCURRENCY,
  scenarios: null,
  jsonPath: null,
};

function formatNumber(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function parseArgs(argv: string[]): Args {
  const args: Args = { ...DEFAULTS };

  const readValue = (i: number) => {
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${argv[i] ?? "arg"}`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--duration-ms") {
      args.durationMs = Number(readValue(i));
      i += 1;
      continue;
    }

    if (arg === "--samples") {
      args.samples = Number(readValue(i));
      i += 1;
      continue;
    }

    if (arg === "--warmup") {
      args.warmup = Number(readValue(i));
      i += 1;
      continue;
    }

    if (arg === "--concurrency") {
      args.concurrency = Number(readValue(i));
      i += 1;
      continue;
    }

    if (arg === "--scenario") {
      const name = readValue(i);
      if (!args.scenarios) args.scenarios = [];
      args.scenarios.push(name);
      i += 1;
      continue;
    }

    if (arg === "--json") {
      args.jsonPath = readValue(i);
      i += 1;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      printHelpAndExit(0);
    }

    throw new Error(`Unknown arg: ${arg}`);
  }

  if (!Number.isFinite(args.durationMs) || args.durationMs <= 0) {
    throw new Error("--duration-ms must be > 0");
  }
  if (!Number.isFinite(args.samples) || args.samples < 3) {
    throw new Error("--samples must be >= 3");
  }
  if (!Number.isFinite(args.warmup) || args.warmup < 0) {
    throw new Error("--warmup must be >= 0");
  }
  if (!Number.isFinite(args.concurrency) || args.concurrency < 1) {
    throw new Error("--concurrency must be >= 1");
  }

  if (args.scenarios) {
    args.scenarios = Array.from(new Set(args.scenarios));
  }

  return args;
}

function printHelpAndExit(code: number): never {
  console.log(`
wreq-js benchmark (local server)

Usage:
  node --expose-gc dist/bench/run.js [options]

Options:
  --duration-ms <n>   sample duration (default: ${DEFAULTS.durationMs})
  --samples <n>       recorded samples (default: ${DEFAULTS.samples})
  --warmup <n>        warmup samples (default: ${DEFAULTS.warmup})
  --concurrency <n>   concurrent in-flight requests (default: ${DEFAULTS.concurrency} = 2x CPU cores, clamped 8..64)
  --scenario <name>   run only one scenario (repeatable)
  --json <path>       write full results as JSON
`);
  process.exit(code);
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

let warnedGc = false;
function maybeGc() {
  if (typeof globalThis.gc === "function") {
    globalThis.gc();
    return;
  }
  if (!warnedGc) {
    warnedGc = true;
    console.warn("Tip: run with `node --expose-gc` for more stable results.");
  }
}

function getGitCommit(): string | undefined {
  try {
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
    const out = spawnSync("git", ["rev-parse", "HEAD"], { stdio: ["ignore", "pipe", "ignore"] });
    if (out.status === 0) {
      const value = String(out.stdout).trim();
      return value.length > 0 ? value : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function mean(values: number[]): number {
  return values.reduce((acc, v) => acc + v, 0) / values.length;
}

function stdevSample(values: number[], sampleMean: number): number {
  if (values.length < 2) return 0;
  let sumSq = 0;
  for (const value of values) {
    const diff = value - sampleMean;
    sumSq += diff * diff;
  }
  return Math.sqrt(sumSq / (values.length - 1));
}

function tCritical95(df: number): number {
  // 95% CI two-tailed, common df table (df 1..30), else normal approx.
  const table: Record<number, number> = {
    1: 12.706,
    2: 4.303,
    3: 3.182,
    4: 2.776,
    5: 2.571,
    6: 2.447,
    7: 2.365,
    8: 2.306,
    9: 2.262,
    10: 2.228,
    11: 2.201,
    12: 2.179,
    13: 2.16,
    14: 2.145,
    15: 2.131,
    16: 2.12,
    17: 2.11,
    18: 2.101,
    19: 2.093,
    20: 2.086,
    21: 2.08,
    22: 2.074,
    23: 2.069,
    24: 2.064,
    25: 2.06,
    26: 2.056,
    27: 2.052,
    28: 2.048,
    29: 2.045,
    30: 2.042,
  };
  return table[df] ?? 1.96;
}

function summarizeSamples(name: string, samples: number[], errors: number): ScenarioResult {
  const m = mean(samples);
  const sd = stdevSample(samples, m);
  const cv = m === 0 ? 0 : sd / m;
  const t = tCritical95(samples.length - 1);
  const margin = t * (sd / Math.sqrt(samples.length));
  const low = m - margin;
  const high = m + margin;

  return {
    name,
    unit: "req/s",
    samples,
    mean: m,
    stdev: sd,
    cv,
    ci95: { low, high, margin, marginPct: m === 0 ? 0 : (margin / m) * 100 },
    min: Math.min(...samples),
    max: Math.max(...samples),
    errors,
  };
}

async function measureThroughput(options: {
  durationMs: number;
  concurrency: number;
  makeRequest: () => Promise<void>;
}): Promise<{ rps: number; errors: number }> {
  const start = performance.now();
  const deadline = start + options.durationMs;

  const workers = Array.from({ length: options.concurrency }, async () => {
    let count = 0;
    let errors = 0;

    while (true) {
      if ((count & 31) === 0 && performance.now() >= deadline) {
        break;
      }
      try {
        await options.makeRequest();
        count += 1;
      } catch {
        errors += 1;
      }
    }

    return { count, errors };
  });

  const results = await Promise.all(workers);
  const elapsed = (performance.now() - start) / 1000;
  const total = results.reduce((acc, v) => acc + v.count, 0);
  const errors = results.reduce((acc, v) => acc + v.errors, 0);
  return { rps: total / elapsed, errors };
}

async function runScenario(options: {
  name: string;
  durationMs: number;
  warmup: number;
  samples: number;
  concurrency: number;
  makeRequest: () => Promise<void>;
}): Promise<ScenarioResult> {
  console.log(`\n== ${options.name} ==`);

  let errors = 0;
  for (let i = 0; i < options.warmup; i += 1) {
    const result = await measureThroughput({
      durationMs: Math.min(500, options.durationMs),
      concurrency: options.concurrency,
      makeRequest: options.makeRequest,
    });
    errors += result.errors;
    maybeGc();
    await sleep(50);
  }

  const samples: number[] = [];
  for (let i = 0; i < options.samples; i += 1) {
    maybeGc();
    await sleep(50);
    const result = await measureThroughput({
      durationMs: options.durationMs,
      concurrency: options.concurrency,
      makeRequest: options.makeRequest,
    });
    errors += result.errors;
    samples.push(result.rps);
    console.log(`sample ${i + 1}/${options.samples}: ${formatNumber(result.rps)} req/s`);
  }

  const summary = summarizeSamples(options.name, samples, errors);
  console.log(
    `mean: ${formatNumber(summary.mean)} req/s  (95% CI ±${formatNumber(summary.ci95.margin)} / ±${formatNumber(
      summary.ci95.marginPct,
    )}%)`,
  );
  console.log(`stdev: ${formatNumber(summary.stdev)}  cv: ${formatNumber(summary.cv * 100)}%  errors: ${errors}`);

  if (summary.ci95.marginPct > 3) {
    console.warn("High variance detected; consider increasing --duration-ms/--samples or lowering --concurrency.");
  }

  return summary;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const server = await startLocalBenchServer();

  const commit = getGitCommit();
  const cpu0 = os.cpus()[0];
  const meta: BenchRun = {
    startedAt: new Date().toISOString(),
    env: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpus: {
        model: cpu0?.model ?? "unknown",
        speed: cpu0?.speed ?? 0,
        cores: os.cpus().length,
      },
    },
    config: {
      durationMs: args.durationMs,
      samples: args.samples,
      warmup: args.warmup,
      concurrency: args.concurrency,
    },
    server: { baseUrl: server.baseUrl },
    results: [],
  };
  if (commit) {
    meta.git = { commit };
  }

  console.log(`Local server: ${server.baseUrl}`);
  if (commit) {
    console.log(`Git commit: ${commit}`);
  }

  const urlSmall = `${server.baseUrl}/small`;
  const urlBinary4k = `${server.baseUrl}/binary?len=4096`;
  const urlPostLen = `${server.baseUrl}/echo-len?len=32`;

  const selected = args.scenarios;
  const shouldRun = (name: string) => !selected || selected.includes(name);

  const results: ScenarioResult[] = [];

  if (shouldRun("wreq.session.get.small")) {
    const session = await createSession();
    try {
      const result = await runScenario({
        name: "wreq.session.get.small",
        ...args,
        makeRequest: async () => {
          const res = await session.fetch(urlSmall);
          if (res.status !== 200) throw new Error(`status ${res.status}`);
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length !== SMALL_BODY_LENGTH) throw new Error("bad body length");
        },
      });
      results.push(result);
    } finally {
      await session.close();
    }
  }

  if (shouldRun("wreq.transport.get.small")) {
    const transport = await createTransport();
    try {
      const result = await runScenario({
        name: "wreq.transport.get.small",
        ...args,
        makeRequest: async () => {
          const res = await wreqFetch(urlSmall, { transport });
          if (res.status !== 200) throw new Error(`status ${res.status}`);
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length !== SMALL_BODY_LENGTH) throw new Error("bad body length");
        },
      });
      results.push(result);
    } finally {
      await transport.close();
    }
  }

  if (shouldRun("wreq.session.get.4kb")) {
    const session = await createSession();
    try {
      const result = await runScenario({
        name: "wreq.session.get.4kb",
        ...args,
        makeRequest: async () => {
          const res = await session.fetch(urlBinary4k);
          if (res.status !== 200) throw new Error(`status ${res.status}`);
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length !== 4096) throw new Error("bad body length");
        },
      });
      results.push(result);
    } finally {
      await session.close();
    }
  }

  if (shouldRun("wreq.session.post.32b")) {
    const session = await createSession();
    const body = Buffer.alloc(32, 1);
    try {
      const result = await runScenario({
        name: "wreq.session.post.32b",
        ...args,
        makeRequest: async () => {
          const res = await session.fetch(urlPostLen, {
            method: "POST",
            body,
            headers: { "Content-Type": "application/octet-stream" },
          });
          if (res.status !== 204) {
            const msg = await res.text().catch(() => "");
            throw new Error(`status ${res.status} ${msg}`);
          }
          await res.arrayBuffer();
        },
      });
      results.push(result);
    } finally {
      await session.close();
    }
  }

  if (shouldRun("wreq.isolated.get.small")) {
    const result = await runScenario({
      name: "wreq.isolated.get.small",
      ...args,
      makeRequest: async () => {
        const res = await wreqFetch(urlSmall);
        if (res.status !== 200) throw new Error(`status ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length !== SMALL_BODY_LENGTH) throw new Error("bad body length");
      },
    });
    results.push(result);
  }

  if (shouldRun("node.fetch.get.small")) {
    if (typeof globalThis.fetch !== "function") {
      console.warn("global fetch is not available; skipping node.fetch.get.small");
    } else {
      const result = await runScenario({
        name: "node.fetch.get.small",
        ...args,
        makeRequest: async () => {
          const res = await globalThis.fetch(urlSmall);
          if (!res.ok) throw new Error(`status ${res.status}`);
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length !== SMALL_BODY_LENGTH) throw new Error("bad body length");
        },
      });
      results.push(result);
    }
  }

  meta.results = results;

  if (args.jsonPath) {
    await writeFile(args.jsonPath, JSON.stringify(meta, null, 2), "utf8");
    console.log(`\nWrote JSON results: ${args.jsonPath}`);
  }

  await server.close();

  console.log("\nDone.");
}

const SMALL_BODY_LENGTH = 2;

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
