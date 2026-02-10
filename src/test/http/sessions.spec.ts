import assert from "node:assert";
import { describe, test } from "node:test";
import type { Session } from "../../wreq-js.js";
import { createSession, RequestError, withSession, fetch as wreqFetch } from "../../wreq-js.js";
import { httpUrl } from "../helpers/http.js";

describe("HTTP sessions", () => {
  test("isolates cookies for default fetch calls", async () => {
    await wreqFetch(httpUrl("/cookies/set?ephemeral=on"), {
      browser: "chrome_142",
      timeout: 5000,
    });

    const response = await wreqFetch(httpUrl("/cookies"), {
      browser: "chrome_142",
      timeout: 5000,
    });

    const body = await response.json<{ cookies: Record<string, string> }>();

    assert.ok(!body.cookies.ephemeral, "Ephemeral cookies should not persist across requests");
  });

  test("isolates cookies between sessions", async () => {
    const sessionA = await createSession({ browser: "chrome_142" });
    const sessionB = await createSession({ browser: "chrome_142" });

    try {
      await sessionA.fetch(httpUrl("/cookies/set?flavor=alpha"), { timeout: 10000 });
      await sessionB.fetch(httpUrl("/cookies/set?flavor=beta"), { timeout: 10000 });

      const cookiesA = await sessionA.fetch(httpUrl("/cookies"), { timeout: 10000 });
      const cookiesB = await sessionB.fetch(httpUrl("/cookies"), { timeout: 10000 });

      const bodyA = await cookiesA.json<{ cookies: Record<string, string> }>();
      const bodyB = await cookiesB.json<{ cookies: Record<string, string> }>();

      assert.strictEqual(bodyA.cookies.flavor, "alpha", "Session A should keep its own cookies");
      assert.strictEqual(bodyB.cookies.flavor, "beta", "Session B should keep its own cookies");
    } finally {
      await sessionA.close();
      await sessionB.close();
    }
  });

  test("clears session cookies on demand", async () => {
    const session = await createSession({ browser: "chrome_142" });

    try {
      await session.fetch(httpUrl("/cookies/set?token=123"), { timeout: 10000 });
      await session.clearCookies();

      const response = await session.fetch(httpUrl("/cookies"), { timeout: 10000 });
      const body = await response.json<{ cookies: Record<string, string> }>();

      assert.deepStrictEqual(body.cookies, {}, "Clearing the session should drop stored cookies");
    } finally {
      await session.close();
    }
  });

  test("withSession helper disposes sessions automatically", async () => {
    let capturedSession: Session | undefined;

    await withSession(async (session: Session) => {
      capturedSession = session;
      const response = await session.fetch(httpUrl("/get"), { timeout: 5000 });
      assert.strictEqual(response.status, 200);
    });

    const session = capturedSession;
    assert.ok(session, "withSession should provide a session instance");

    await assert.rejects(
      async () => {
        await session.fetch(httpUrl("/get"), { timeout: 5000 });
      },
      (error: unknown) => error instanceof RequestError,
      "Using a closed session should fail",
    );
  });

  test("rejects changing session proxy per request", async () => {
    const session = await createSession({ browser: "chrome_142" });

    try {
      await assert.rejects(
        session.fetch(httpUrl("/get"), { proxy: "http://proxy.example.com:8080", timeout: 5_000 }),
        (error: unknown) => error instanceof RequestError && /Session proxy cannot be changed/.test(error.message),
      );
    } finally {
      await session.close();
    }
  });
});
