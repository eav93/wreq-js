#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const DEFAULT_REGION = "us-west-2";

function usage() {
  console.log(`Usage: pricing-info.mjs --instance-type <type> [options]

Options:
  --region <aws-region>   Region to inspect (default: us-west-2)
  --cheapest              Scan enabled regions and return cheapest on-demand region
  --top <n>               Number of top cheapest regions to include (default: 5)
  -h, --help              Show help`);
}

function parseArgs(argv) {
  const args = {
    instanceType: "",
    region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || DEFAULT_REGION,
    cheapest: false,
    top: 5,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    switch (token) {
      case "--instance-type":
        args.instanceType = argv[i + 1] || "";
        i += 1;
        break;
      case "--region":
        args.region = argv[i + 1] || "";
        i += 1;
        break;
      case "--cheapest":
        args.cheapest = true;
        break;
      case "--top":
        args.top = Number(argv[i + 1] || "5");
        i += 1;
        break;
      case "-h":
      case "--help":
        usage();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }

  if (!args.instanceType) {
    throw new Error("--instance-type is required");
  }
  if (!args.region) {
    throw new Error("--region must not be empty");
  }
  if (!Number.isInteger(args.top) || args.top < 1) {
    throw new Error("--top must be a positive integer");
  }

  return args;
}

function runAwsJson(args, allowFailure = false) {
  const result = spawnSync("aws", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 8 * 1024 * 1024,
  });

  if (result.status !== 0) {
    if (allowFailure) {
      return null;
    }
    const stderr = result.stderr?.trim();
    throw new Error(stderr || `aws ${args.join(" ")} failed with status ${result.status}`);
  }

  const stdout = result.stdout?.trim();
  if (!stdout) {
    return null;
  }
  return JSON.parse(stdout);
}

function extractOnDemandHourly(productPayload, fallbackRegionCode) {
  const priceList = productPayload?.PriceList;
  if (!Array.isArray(priceList) || priceList.length === 0) {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(priceList[0]);
  } catch {
    return null;
  }

  const terms = parsed?.terms?.OnDemand || {};
  for (const term of Object.values(terms)) {
    const dimensions = term?.priceDimensions || {};
    for (const dimension of Object.values(dimensions)) {
      if (dimension?.unit !== "Hrs") {
        continue;
      }

      const usd = Number(dimension?.pricePerUnit?.USD);
      if (!Number.isFinite(usd) || usd <= 0) {
        continue;
      }

      return {
        regionCode: parsed?.product?.attributes?.regionCode || fallbackRegionCode,
        location: parsed?.product?.attributes?.location || "",
        usdPerHour: usd,
        effectiveDate: term?.effectiveDate || null,
      };
    }
  }

  return null;
}

function getOnDemandPrice(instanceType, regionCode) {
  const payload = runAwsJson(
    [
      "pricing",
      "get-products",
      "--region",
      "us-east-1",
      "--service-code",
      "AmazonEC2",
      "--filters",
      `Type=TERM_MATCH,Field=regionCode,Value=${regionCode}`,
      `Type=TERM_MATCH,Field=instanceType,Value=${instanceType}`,
      "Type=TERM_MATCH,Field=operatingSystem,Value=Linux",
      "Type=TERM_MATCH,Field=tenancy,Value=Shared",
      "Type=TERM_MATCH,Field=preInstalledSw,Value=NA",
      "Type=TERM_MATCH,Field=capacitystatus,Value=Used",
      "Type=TERM_MATCH,Field=licenseModel,Value=No License required",
      "--max-results",
      "1",
      "--output",
      "json",
    ],
    true,
  );

  if (!payload) {
    return null;
  }
  return extractOnDemandHourly(payload, regionCode);
}

function listEnabledRegions() {
  const regions = runAwsJson(
    [
      "ec2",
      "describe-regions",
      "--all-regions",
      "--query",
      "Regions[?OptInStatus==`opt-in-not-required` || OptInStatus==`opted-in`].RegionName",
      "--output",
      "json",
    ],
    false,
  );
  if (!Array.isArray(regions)) {
    return [];
  }
  return regions.filter((value) => typeof value === "string" && value.length > 0);
}

function getSpotStats(instanceType, regionCode) {
  const startTime = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const prices = runAwsJson(
    [
      "ec2",
      "describe-spot-price-history",
      "--region",
      regionCode,
      "--instance-types",
      instanceType,
      "--product-descriptions",
      "Linux/UNIX",
      "--start-time",
      startTime,
      "--max-items",
      "500",
      "--query",
      "SpotPriceHistory[].SpotPrice",
      "--output",
      "json",
    ],
    true,
  );

  if (!Array.isArray(prices) || prices.length === 0) {
    return null;
  }

  const values = prices.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0);
  if (values.length === 0) {
    return null;
  }

  let min = values[0];
  let max = values[0];
  let sum = 0;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
    sum += value;
  }

  return {
    windowHours: 24,
    samples: values.length,
    minUsdPerHour: min,
    avgUsdPerHour: sum / values.length,
    maxUsdPerHour: max,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const report = {
    generatedAt: new Date().toISOString(),
    instanceType: args.instanceType,
    selectedRegion: args.region,
    selectedOnDemand: getOnDemandPrice(args.instanceType, args.region),
    selectedSpot24h: getSpotStats(args.instanceType, args.region),
  };

  if (args.cheapest) {
    const rows = [];
    for (const regionCode of listEnabledRegions()) {
      const row = getOnDemandPrice(args.instanceType, regionCode);
      if (row) {
        rows.push(row);
      }
    }

    rows.sort((left, right) => left.usdPerHour - right.usdPerHour);
    report.regionCountSampled = rows.length;
    report.cheapestOnDemand = rows[0] || null;
    report.topOnDemand = rows.slice(0, args.top);
  }

  console.log(JSON.stringify(report, null, 2));
}

try {
  main();
} catch (error) {
  console.error(`[pricing-info] ERROR: ${error?.message || String(error)}`);
  process.exit(1);
}
