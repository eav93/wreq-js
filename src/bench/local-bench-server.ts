import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

export interface LocalBenchServer {
  baseUrl: string;
  close(): Promise<void>;
}

type BenchRoute = {
  method: string;
  path: string;
};

const SMALL_BODY = Buffer.from("OK", "utf8");
const JSON_BODY = Buffer.from('{"ok":true,"message":"hello"}', "utf8");
const BINARY_4K_BODY = Buffer.alloc(4096, 0xab);

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

  return { baseUrl, close };

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
