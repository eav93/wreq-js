import assert from "node:assert";
import { describe, test } from "node:test";
import { createSession, fetch as wreqFetch } from "../../wreq-js";

// Self-signed certificate test hosts
const SELF_SIGNED_HOST = "https://self-signed.badssl.com/";
const EXPIRED_HOST = "https://expired.badssl.com/";

describe("Insecure certificate verification", () => {
  test("rejects self-signed certificates by default", async () => {
    await assert.rejects(
      wreqFetch(SELF_SIGNED_HOST, {
        browser: "chrome_142",
        timeout: 10_000,
      }),
      (error: unknown) => {
        return error instanceof Error &&
          (error.message.includes("certificate") ||
           error.message.includes("SSL") ||
           error.message.includes("TLS"));
      },
      "Should reject self-signed certificates by default",
    );
  });

  test("accepts self-signed certificates when insecure is enabled", async () => {
    const response = await wreqFetch(SELF_SIGNED_HOST, {
      browser: "chrome_142",
      timeout: 10_000,
      insecure: true,
    });

    assert.ok(response.status >= 200 && response.status < 400, "Should accept self-signed certificate with insecure flag");
  });

  test("rejects expired certificates by default", async () => {
    await assert.rejects(
      wreqFetch(EXPIRED_HOST, {
        browser: "chrome_142",
        timeout: 10_000,
      }),
      (error: unknown) => {
        return error instanceof Error &&
          (error.message.includes("certificate") ||
           error.message.includes("SSL") ||
           error.message.includes("TLS") ||
           error.message.includes("expired"));
      },
      "Should reject expired certificates by default",
    );
  });

  test("accepts expired certificates when insecure is enabled", async () => {
    const response = await wreqFetch(EXPIRED_HOST, {
      browser: "chrome_142",
      timeout: 10_000,
      insecure: true,
    });

    assert.ok(response.status >= 200 && response.status < 400, "Should accept expired certificate with insecure flag");
  });

  test("rejects self-signed certificates in sessions by default", async () => {
    const session = await createSession({
      browser: "chrome_142",
      timeout: 10_000,
    });

    try {
      await assert.rejects(
        session.fetch(SELF_SIGNED_HOST, {
          timeout: 10_000,
        }),
        (error: unknown) => {
          return error instanceof Error &&
            (error.message.includes("certificate") ||
             error.message.includes("SSL") ||
             error.message.includes("TLS"));
        },
        "Session should reject self-signed certificates by default",
      );
    } finally {
      await session.close();
    }
  });

  test("accepts self-signed certificates in sessions with insecure enabled", async () => {
    const session = await createSession({
      browser: "chrome_142",
      timeout: 10_000,
      insecure: true,
    });

    try {
      const response = await session.fetch(SELF_SIGNED_HOST, {
        timeout: 10_000,
      });

      assert.ok(response.status >= 200 && response.status < 400, "Session should accept self-signed certificate with insecure flag");
    } finally {
      await session.close();
    }
  });

  test("session insecure setting applies to all requests", async () => {
    const session = await createSession({
      browser: "chrome_142",
      timeout: 10_000,
      insecure: true,
    });

    try {
      // Test multiple hosts with certificate issues
      const response1 = await session.fetch(SELF_SIGNED_HOST, {
        timeout: 10_000,
      });

      const response2 = await session.fetch(EXPIRED_HOST, {
        timeout: 10_000,
      });

      assert.ok(response1.status >= 200 && response1.status < 400, "Should handle first insecure request");
      assert.ok(response2.status >= 200 && response2.status < 400, "Should handle second insecure request");
    } finally {
      await session.close();
    }
  });

  test("insecure defaults to false", async () => {
    // Test that omitting the insecure option still validates certificates
    await assert.rejects(
      wreqFetch(SELF_SIGNED_HOST, {
        browser: "chrome_142",
        timeout: 10_000,
        // insecure not specified, should default to false
      }),
      (error: unknown) => {
        return error instanceof Error &&
          (error.message.includes("certificate") ||
           error.message.includes("SSL") ||
           error.message.includes("TLS"));
      },
      "Should validate certificates when insecure is not specified",
    );
  });

  test("insecure: false explicitly validates certificates", async () => {
    await assert.rejects(
      wreqFetch(SELF_SIGNED_HOST, {
        browser: "chrome_142",
        timeout: 10_000,
        insecure: false,
      }),
      (error: unknown) => {
        return error instanceof Error &&
          (error.message.includes("certificate") ||
           error.message.includes("SSL") ||
           error.message.includes("TLS"));
      },
      "Should validate certificates when insecure is explicitly false",
    );
  });
});
