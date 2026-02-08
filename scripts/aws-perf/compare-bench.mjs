#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";

function parseArgs(argv) {
  const args = {
    thresholdPct: 5,
    failOnRegression: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--base") {
      if (!next) throw new Error("Missing value for --base");
      args.basePath = next;
      i += 1;
      continue;
    }
    if (arg === "--head") {
      if (!next) throw new Error("Missing value for --head");
      args.headPath = next;
      i += 1;
      continue;
    }
    if (arg === "--threshold-pct") {
      if (!next) throw new Error("Missing value for --threshold-pct");
      args.thresholdPct = Number(next);
      i += 1;
      continue;
    }
    if (arg === "--markdown") {
      if (!next) throw new Error("Missing value for --markdown");
      args.markdownPath = next;
      i += 1;
      continue;
    }
    if (arg === "--json") {
      if (!next) throw new Error("Missing value for --json");
      args.jsonPath = next;
      i += 1;
      continue;
    }
    if (arg === "--no-fail") {
      args.failOnRegression = false;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!args.basePath || !args.headPath) {
    throw new Error("Usage: compare-bench.mjs --base <path> --head <path> [--threshold-pct <n>]");
  }

  if (!Number.isFinite(args.thresholdPct) || args.thresholdPct < 0) {
    throw new Error("--threshold-pct must be a non-negative number");
  }

  return args;
}

function formatNum(value) {
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function formatPct(value) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function loadBench(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function compare(baseRun, headRun, thresholdPct) {
  const byName = (run) => new Map(run.results.map((result) => [result.name, result]));
  const baseMap = byName(baseRun);
  const headMap = byName(headRun);

  const names = [...baseMap.keys()].filter((name) => headMap.has(name));
  names.sort();

  const scenarios = names.map((name) => {
    const base = baseMap.get(name);
    const head = headMap.get(name);

    const deltaPct = ((head.mean - base.mean) / base.mean) * 100;
    const regression = deltaPct <= -thresholdPct;
    const improvement = deltaPct >= thresholdPct;

    return {
      name,
      baseMean: base.mean,
      headMean: head.mean,
      deltaPct,
      baseCiPct: base.ci95.marginPct,
      headCiPct: head.ci95.marginPct,
      baseErrors: base.errors,
      headErrors: head.errors,
      status: regression ? "REGRESSION" : improvement ? "IMPROVEMENT" : "OK",
    };
  });

  const regressions = scenarios.filter((item) => item.status === "REGRESSION");

  return {
    generatedAt: new Date().toISOString(),
    thresholdPct,
    baseCommit: baseRun.git?.commit,
    headCommit: headRun.git?.commit,
    regressions: regressions.map((item) => item.name),
    pass: regressions.length === 0,
    scenarios,
  };
}

function toMarkdown(report) {
  const lines = [];
  lines.push("# AWS Perf Compare");
  lines.push("");
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Threshold: ${report.thresholdPct}% throughput drop => regression`);
  if (report.baseCommit) lines.push(`- Base commit: ${report.baseCommit}`);
  if (report.headCommit) lines.push(`- Head commit: ${report.headCommit}`);
  lines.push("");
  lines.push("| Scenario | Base req/s | Head req/s | Delta | Status | Base CI | Head CI |");
  lines.push("|---|---:|---:|---:|---|---:|---:|");

  for (const scenario of report.scenarios) {
    lines.push(
      `| ${scenario.name} | ${formatNum(scenario.baseMean)} | ${formatNum(scenario.headMean)} | ${formatPct(scenario.deltaPct)} | ${scenario.status} | ±${scenario.baseCiPct.toFixed(2)}% | ±${scenario.headCiPct.toFixed(2)}% |`,
    );
  }

  lines.push("");
  lines.push(`## Gate: ${report.pass ? "PASS" : "FAIL"}`);
  if (!report.pass) {
    lines.push(`Regressions: ${report.regressions.join(", ")}`);
  }

  return lines.join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseRun = loadBench(args.basePath);
  const headRun = loadBench(args.headPath);
  const report = compare(baseRun, headRun, args.thresholdPct);
  const markdown = toMarkdown(report);

  if (args.markdownPath) {
    writeFileSync(args.markdownPath, markdown, "utf8");
  }

  if (args.jsonPath) {
    writeFileSync(args.jsonPath, JSON.stringify(report, null, 2), "utf8");
  }

  console.log(markdown);

  if (!report.pass && args.failOnRegression) {
    process.exit(2);
  }
}

main();
