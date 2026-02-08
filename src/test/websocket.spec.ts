import assert from "node:assert";
import { before, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { RequestError, websocket } from "../wreq-js.js";

const WS_TEST_URL = process.env.WS_TEST_URL;

if (!WS_TEST_URL) {
  throw new Error("WS_TEST_URL environment variable must be set by the test runner");
}

describe("WebSocket", () => {
  before(() => {
    console.log("🔌 WebSocket Test Suite\n");
  });

  test("should connect to WebSocket and send/receive messages", async () => {
    const messages: (string | Buffer)[] = [];
    let isClosed = false;
    let closeEvent: { code: number; reason: string } | undefined;

    const ws = await websocket({
      url: WS_TEST_URL,
      browser: "chrome_142",
      onMessage: (data: string | Buffer) => {
        messages.push(data);
      },
      onClose: (event) => {
        isClosed = true;
        closeEvent = event;
      },
      onError: (error: string) => {
        console.error("WebSocket error:", error);
      },
    });

    console.log("WebSocket connected");

    await ws.send("Hello!");

    // Wait for echo response
    await sleep(100);
    assert.ok(messages.length > 0, "Should receive at least one message");

    // Wait a bit for close callback
    await ws.close();
    await sleep(100);
    assert.ok(isClosed, "Should receive close event");
    assert.ok(closeEvent, "Should receive close metadata");
    assert.strictEqual(typeof closeEvent?.code, "number");
    assert.strictEqual(typeof closeEvent?.reason, "string");
  });

  test("should handle parallel sends on same WebSocket", async () => {
    const messages: (string | Buffer)[] = [];
    const expectedMessages = ["Message 1", "Message 2", "Message 3", "Message 4", "Message 5"];

    const ws = await websocket({
      url: WS_TEST_URL,
      browser: "chrome_142",
      onMessage: (data: string | Buffer) => {
        messages.push(data);
      },
      onClose: () => {},
      onError: (error: string) => {
        console.error("WebSocket error:", error);
      },
    });

    console.log("Testing parallel sends...");

    // Send multiple messages in parallel
    await Promise.all([
      ws.send("Message 1"),
      ws.send("Message 2"),
      ws.send("Message 3"),
      ws.send("Message 4"),
      ws.send("Message 5"),
    ]);

    console.log("All messages sent in parallel");

    // Wait for echo responses
    await sleep(200);

    assert.ok(messages.length >= 5, "Should receive at least 5 messages");

    // Verify that all expected messages were received (order may vary)
    const receivedStrings = messages.map((m) => (Buffer.isBuffer(m) ? m.toString() : m));

    for (const expected of expectedMessages) {
      assert.ok(
        receivedStrings.includes(expected),
        `Should receive message: "${expected}". Got: ${receivedStrings.join(", ")}`,
      );
    }
    console.log("All messages received correctly:", receivedStrings.join(", "));

    await ws.close();
  });

  test("should send binary data from Uint8Array and ArrayBuffer", async () => {
    const messages: (string | Buffer)[] = [];

    const ws = await websocket({
      url: WS_TEST_URL,
      browser: "chrome_142",
      onMessage: (data: string | Buffer) => {
        messages.push(data);
      },
      onClose: () => {},
      onError: () => {},
    });

    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    await ws.send(bytes);
    await ws.send(bytes.buffer.slice(0));

    await sleep(200);

    const binaryMessages = messages.filter((message): message is Buffer => Buffer.isBuffer(message));
    assert.ok(
      binaryMessages.some((payload) => payload.equals(Buffer.from(bytes))),
      "Should echo Uint8Array payload",
    );
    assert.ok(
      binaryMessages.some((payload) => payload.equals(Buffer.from(bytes.buffer))),
      "Should echo ArrayBuffer payload",
    );

    await ws.close();
  });

  test("should handle multiple WebSocket connections simultaneously", async () => {
    const ws1Messages: (string | Buffer)[] = [];
    const ws2Messages: (string | Buffer)[] = [];

    // Create two WebSocket connections in parallel
    const [ws1, ws2] = await Promise.all([
      websocket({
        url: WS_TEST_URL,
        browser: "chrome_142",
        onMessage: (data: string | Buffer) => ws1Messages.push(data),
        onClose: () => {},
        onError: () => {},
      }),
      websocket({
        url: WS_TEST_URL,
        browser: "firefox_139",
        onMessage: (data: string | Buffer) => ws2Messages.push(data),
        onClose: () => {},
        onError: () => {},
      }),
    ]);

    console.log("WebSocket connections created");

    // Send unique messages on both connections in parallel
    await Promise.all([ws1.send("From WS1"), ws2.send("From WS2")]);

    // Wait for responses
    await sleep(200);

    assert.ok(ws1Messages.length > 0, "WS1 should receive messages");
    assert.ok(ws2Messages.length > 0, "WS2 should receive messages");

    // Verify that each connection received the correct message (not mixed up)
    // Note: echo.websocket.org sends a "Request served by..." message first, then echoes
    const ws1Strings = ws1Messages.map((m) => (Buffer.isBuffer(m) ? m.toString() : m));
    const ws2Strings = ws2Messages.map((m) => (Buffer.isBuffer(m) ? m.toString() : m));

    assert.ok(ws1Strings.includes("From WS1"), "WS1 should receive its own message");
    assert.ok(ws2Strings.includes("From WS2"), "WS2 should receive its own message");

    // Verify messages are not mixed up between connections
    assert.ok(!ws1Strings.includes("From WS2"), "WS1 should NOT receive WS2 message");
    assert.ok(!ws2Strings.includes("From WS1"), "WS2 should NOT receive WS1 message");

    console.log("Messages correctly isolated between connections:");
    console.log("  WS1:", ws1Strings);
    console.log("  WS2:", ws2Strings);

    // Close both connections
    await Promise.all([ws1.close(), ws2.close()]);
  });

  test("rejects missing url or onMessage", async () => {
    await assert.rejects(
      websocket({ url: "", browser: "chrome_142", onMessage: () => {} }),
      (error: unknown) => error instanceof RequestError && /URL is required/.test(error.message),
    );

    await assert.rejects(
      websocket({ url: WS_TEST_URL, browser: "chrome_142" } as never),
      (error: unknown) => error instanceof RequestError && /onMessage callback is required/.test(error.message),
    );
  });

  test("wraps connection errors as RequestError", { timeout: 5000 }, async () => {
    await assert.rejects(
      websocket({ url: "ws://127.0.0.1:1", browser: "chrome_142", onMessage: () => {} }),
      (error: unknown) => error instanceof RequestError,
    );
  });

  test("provides close code and reason from server close frames", async () => {
    const closeUrl = new URL(WS_TEST_URL);
    closeUrl.searchParams.set("closeCode", "4001");
    closeUrl.searchParams.set("closeReason", "shutdown");

    let closeEvent: { code: number; reason: string } | undefined;

    await websocket({
      url: closeUrl.toString(),
      browser: "chrome_142",
      onMessage: () => {},
      onClose: (event) => {
        closeEvent = event;
      },
      onError: () => {},
    });

    for (let i = 0; i < 20 && !closeEvent; i += 1) {
      await sleep(25);
    }

    assert.ok(closeEvent, "Should receive close callback");
    assert.strictEqual(closeEvent?.code, 4001);
    assert.strictEqual(closeEvent?.reason, "shutdown");
  });
});
