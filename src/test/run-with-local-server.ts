import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { startLocalTestServer } from "./helpers/local-test-server";

const testDir = __dirname;
const projectRoot = resolve(testDir, "..", "..");
const httpTestDir = resolve(testDir, "http");
const httpTestFiles = existsSync(httpTestDir)
  ? readdirSync(httpTestDir)
      .filter((filename) => filename.endsWith(".spec.js"))
      .map((filename) => resolve(httpTestDir, filename))
      .sort()
  : [];

async function main() {
  const extraArgs = process.argv.slice(2);
  const defaultTestFiles = [...httpTestFiles, resolve(testDir, "websocket.spec.js")];

  const normalizeArg = (arg: string): string => {
    const abs = resolve(process.cwd(), arg);
    if (abs.endsWith(".ts")) {
      const srcPrefix = `${resolve(projectRoot, "src")}/`;
      if (abs.startsWith(srcPrefix)) {
        const rel = abs.slice(srcPrefix.length);
        return resolve(projectRoot, "dist", rel.replace(/\.ts$/, ".js"));
      }
      return abs.replace(/\.ts$/, ".js");
    }
    return abs;
  };

  const normalizedExtraArgs = Array.from(new Set(extraArgs.map(normalizeArg)));

  const env = { ...process.env };

  const localServer = await startLocalTestServer();
  env.HTTP_TEST_BASE_URL = localServer.httpBaseUrl;
  env.WS_TEST_URL = localServer.wsUrl;

  const nodeArgs = ["--test", ...defaultTestFiles, ...normalizedExtraArgs];
  const testProcess = spawn(process.execPath, nodeArgs, {
    stdio: "inherit",
    env,
  });

  const cleanup = async () => {
    try {
      await localServer.close();
    } catch (error) {
      console.error("Failed to stop local test server:", error);
    }
  };

  testProcess.once("exit", async (code, signal) => {
    await cleanup();
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });

  testProcess.once("error", async (error) => {
    console.error("Failed to run tests:", error);
    await cleanup();
    process.exit(1);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
