import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type ServerKind = "rust" | "node";

export interface LocalBenchServer {
  baseUrl: string;
  kind: ServerKind;
  close(): Promise<void>;
}

type BenchRoute = {
  method: string;
  path: string;
};

const SMALL_BODY = Buffer.from("OK", "utf8");
const JSON_BODY = Buffer.from('{"ok":true,"message":"hello"}', "utf8");
const BINARY_4K_BODY = Buffer.alloc(4096, 0xab);

function findBenchServerBinary(): string | null {
  const thisFile = fileURLToPath(import.meta.url);
  const projectRoot = resolve(thisFile, "..", "..", "..");
  const binary = resolve(projectRoot, "rust", "bench-server", "target", "release", "wreq-bench-server");
  return existsSync(binary) ? binary : null;
}

function startRustBenchServer(): Promise<LocalBenchServer | null> {
  const binary = findBenchServerBinary();
  if (!binary) return Promise.resolve(null);

  return new Promise<LocalBenchServer | null>((resolvePromise) => {
    const serverCpu = process.env.BENCH_SERVER_CPU;
    let proc: ChildProcess;

    if (serverCpu && process.platform === "linux") {
      proc = spawn("taskset", ["-c", serverCpu, binary], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } else {
      proc = spawn(binary, [], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    }

    let settled = false;
    let stdoutBuf = "";

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill("SIGKILL");
        resolvePromise(null);
      }
    }, 5000);

    proc.on("error", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        resolvePromise(null);
      }
    });

    proc.on("exit", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        resolvePromise(null);
      }
    });

    proc.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      stdoutBuf += chunk.toString();
      const newlineIdx = stdoutBuf.indexOf("\n");
      if (newlineIdx === -1) return;

      const portStr = stdoutBuf.slice(0, newlineIdx).trim();
      const port = Number(portStr);
      if (!Number.isFinite(port) || port <= 0) {
        settled = true;
        clearTimeout(timeout);
        proc.kill("SIGKILL");
        resolvePromise(null);
        return;
      }

      settled = true;
      clearTimeout(timeout);

      const baseUrl = `http://127.0.0.1:${port}`;
      const close = async () => {
        proc.kill("SIGTERM");
        await new Promise<void>((r) => {
          const killTimeout = setTimeout(() => {
            proc.kill("SIGKILL");
          }, 2000);
          proc.on("exit", () => {
            clearTimeout(killTimeout);
            r();
          });
        });
      };

      resolvePromise({ baseUrl, kind: "rust", close });
    });
  });
}

export async function startBenchServer(): Promise<LocalBenchServer> {
  const rust = await startRustBenchServer();
  if (rust) return rust;
  return startLocalBenchServer();
}

export async function startLocalBenchServer(): Promise<LocalBenchServer> {
  const sockets = new Set<Socket>();

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((error) => {
      console.error("Local bench server request error:", error);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
      }
      res.end("internal server error");
    });
  });

  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.setNoDelay(true);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: unknown) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });

  const address = server.address() as AddressInfo | null;
  if (!address) {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    throw new Error("Unable to determine local bench server address");
  }

  const baseUrl = `http://127.0.0.1:${address.port}`;

  const close = async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  };

  return { baseUrl, kind: "node", close };

  async function handleRequest(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", baseUrl);
    const route: BenchRoute = { method: req.method ?? "GET", path: url.pathname };

    if (route.method === "GET" && route.path === "/small") {
      return sendBytes(res, 200, "text/plain; charset=utf-8", SMALL_BODY);
    }

    if (route.method === "GET" && route.path === "/json") {
      return sendBytes(res, 200, "application/json; charset=utf-8", JSON_BODY);
    }

    if (route.method === "GET" && route.path === "/binary") {
      const lengthParam = url.searchParams.get("len");
      const length =
        Number.isFinite(Number(lengthParam)) && Number(lengthParam) > 0
          ? Math.min(Number(lengthParam), 1024 * 1024)
          : 4096;

      if (length === 4096) {
        return sendBytes(res, 200, "application/octet-stream", BINARY_4K_BODY);
      }

      const payload = Buffer.alloc(length, 0xab);
      return sendBytes(res, 200, "application/octet-stream", payload);
    }

    if (route.method === "POST" && route.path === "/echo-len") {
      const expectedLength = Number(url.searchParams.get("len") ?? "0");
      const received = await drainBody(req, expectedLength);

      if (expectedLength > 0 && received !== expectedLength) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end(`expected ${expectedLength}, got ${received}`);
        return;
      }

      res.statusCode = 204;
      res.end();
      return;
    }

    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("not found");
  }
}

function sendBytes(res: ServerResponse, status: number, contentType: string, body: Buffer) {
  res.statusCode = status;
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Length", String(body.length));
  res.end(body);
}

async function drainBody(req: IncomingMessage, maxBytes: number): Promise<number> {
  let total = 0;
  for await (const chunk of req) {
    if (typeof chunk === "string") {
      total += Buffer.byteLength(chunk);
    } else {
      total += (chunk as Uint8Array).byteLength;
    }
    if (maxBytes > 0 && total > maxBytes) {
      req.destroy();
      break;
    }
  }
  return total;
}
