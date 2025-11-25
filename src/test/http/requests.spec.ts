import assert from "node:assert";
import { randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fetch as wreqFetch } from "../../wreq-js";
import { httpUrl } from "../helpers/http";

const isLocalHttpBase =
  (process.env.HTTP_TEST_BASE_URL ?? "").includes("127.0.0.1") ||
  (process.env.HTTP_TEST_BASE_URL ?? "").includes("localhost");

describe("HTTP requests", () => {
  test("performs a basic GET request", async () => {
    const response = await wreqFetch(httpUrl("/get"), {
      browser: "chrome_131",
      timeout: 10000,
    });

    assert.ok(response.status >= 200 && response.status < 300, "Should return successful status");
    assert.ok(response.headers.has("content-type"), "Should have response headers");

    const body = await response.json<{ headers: Record<string, string> }>();

    assert.ok(body.headers["User-Agent"], "Should have User-Agent header");
    assert.ok(response.bodyUsed, "json() should mark the body as used");
  });

  test("supports multiple browser profiles", async () => {
    const testUrl = httpUrl("/user-agent");
    const browsers = ["chrome_142", "firefox_139", "safari_18"] as const;

    for (const browser of browsers) {
      const response = await wreqFetch(testUrl, {
        browser,
        timeout: 10000,
      });

      assert.strictEqual(response.status, 200, `${browser} should return status 200`);

      const data = JSON.parse(response.body.toString("utf8"));

      assert.ok(data["user-agent"], `${browser} should provide a user-agent header`);
    }
  });

  test("provides functional clone and text helpers", async () => {
    const response = await wreqFetch(httpUrl("/json"), {
      browser: "chrome_142",
      timeout: 10000,
    });

    const clone = response.clone();
    const original = await response.json();
    const cloneText = await clone.text();

    assert.ok(original, "json() should parse successfully");
    assert.ok(cloneText.length > 0, "clone text should return payload");
    assert.ok(response.bodyUsed, "original body should be consumed");
    assert.ok(clone.bodyUsed, "clone body should be consumed");
  });

  test("preserves binary response bodies", async () => {
    const response = await wreqFetch(httpUrl("/binary"), {
      browser: "chrome_142",
      timeout: 10000,
    });

    const buf = Buffer.from(await response.arrayBuffer());

    assert.strictEqual(buf.length, 256, "binary response should match expected length");
    for (let i = 0; i < buf.length; i += 1) {
      assert.strictEqual(buf[i], i % 256, "binary response should preserve byte order");
    }
    assert.ok(response.bodyUsed, "arrayBuffer() should mark the body as used");
  });

  test("propagates AbortSignal to native I/O", { skip: !isLocalHttpBase }, async () => {
    const controller = new AbortController();
    const hangId = randomUUID();

    const requestPromise = wreqFetch(httpUrl(`/hang?id=${hangId}`), {
      browser: "chrome_142",
      timeout: 10_000,
      signal: controller.signal,
    });

    setTimeout(() => controller.abort("test abort"), 50);

    await assert.rejects(
      requestPromise,
      (error: unknown) => error instanceof Error && error.name === "AbortError",
      "fetch should reject with AbortError when aborted",
    );

    await delay(25);

    const statusResponse = await wreqFetch(httpUrl(`/hang/status?id=${hangId}`), {
      browser: "chrome_142",
      timeout: 5_000,
    });

    const status = await statusResponse.json<{ closed: boolean }>();
    assert.strictEqual(status.closed, true, "server should observe connection close after abort");
  });
});
