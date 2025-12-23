const path = require("node:path");

const target = process.env.WREQ_TARGET;
const platformArchOverride = process.env.WREQ_PLATFORM_ARCH;

const targetMap = {
  "x86_64-apple-darwin": "darwin-x64",
  "aarch64-apple-darwin": "darwin-arm64",
  "x86_64-unknown-linux-gnu": "linux-x64-gnu",
  "aarch64-unknown-linux-gnu": "linux-arm64-gnu",
  "x86_64-unknown-linux-musl": "linux-x64-musl",
  "x86_64-pc-windows-msvc": "win32-x64-msvc",
};

const platformArch = platformArchOverride ?? (target ? targetMap[target] : undefined);

if (!platformArch) {
  throw new Error("Set WREQ_TARGET or WREQ_PLATFORM_ARCH to locate the native binding.");
}

const binaryName = `wreq-js.${platformArch}.node`;
const bindingPath = path.join(__dirname, "..", "rust", binaryName);
const binding = require(bindingPath);

if (typeof binding.getProfiles !== "function") {
  throw new Error(`${binaryName} did not export getProfiles()`);
}

const profiles = binding.getProfiles();
if (!Array.isArray(profiles) || profiles.length === 0) {
  throw new Error(`${binaryName} returned no profiles`);
}

console.log(`smoke-ok ${binaryName} profiles=${profiles.length}`);
