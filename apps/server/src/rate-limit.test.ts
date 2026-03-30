import assert from "node:assert/strict";
import test from "node:test";
import { createBridgeApp } from "./app.js";
import { initAuth } from "./auth.js";
import { resetStore, users } from "./store.js";

async function makeAppWithRateLimits(rateLimit: {
  authLoginMax?: number;
  authLoginWindowMs?: number;
  authFailureMax?: number;
  authFailureWindowMs?: number;
  apiMax?: number;
  apiWindowMs?: number;
}) {
  resetStore();
  await initAuth(users);
  const { app } = await createBridgeApp("http://localhost:5173", { rateLimit });
  return { app };
}

test("login failure brute-force limit returns 429 after threshold", async (t) => {
  const { app } = await makeAppWithRateLimits({
    authLoginMax: 100,
    authFailureMax: 2,
    authFailureWindowMs: 60_000
  });
  t.after(async () => {
    await app.close();
  });

  const attempt1 = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email: "alex@bridge.local", password: "wrong-password" }
  });
  const attempt2 = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email: "alex@bridge.local", password: "wrong-password" }
  });
  const attempt3 = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email: "alex@bridge.local", password: "wrong-password" }
  });

  assert.equal(attempt1.statusCode, 401);
  assert.equal(attempt2.statusCode, 401);
  assert.equal(attempt3.statusCode, 429);
  assert.equal(attempt3.json().message, "rate limit exceeded");
});

test("login request burst limit throttles repeated login calls", async (t) => {
  const { app } = await makeAppWithRateLimits({
    authLoginMax: 2,
    authLoginWindowMs: 60_000,
    authFailureMax: 100
  });
  t.after(async () => {
    await app.close();
  });

  const attempt1 = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email: "alex@bridge.local", password: "bridge123!" }
  });
  const attempt2 = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email: "alex@bridge.local", password: "bridge123!" }
  });
  const attempt3 = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email: "alex@bridge.local", password: "bridge123!" }
  });

  assert.equal(attempt1.statusCode, 200);
  assert.equal(attempt2.statusCode, 200);
  assert.equal(attempt3.statusCode, 429);
});

test("authenticated API requests are rate limited", async (t) => {
  const { app } = await makeAppWithRateLimits({
    apiMax: 2,
    apiWindowMs: 60_000
  });
  t.after(async () => {
    await app.close();
  });

  const login = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email: "alex@bridge.local", password: "bridge123!" }
  });
  assert.equal(login.statusCode, 200);
  const session = login.cookies.find((entry) => entry.name === "bridge_session");
  assert.ok(session);

  const request1 = await app.inject({
    method: "GET",
    url: "/me/unread",
    cookies: { bridge_session: session.value }
  });
  const request2 = await app.inject({
    method: "GET",
    url: "/me/unread",
    cookies: { bridge_session: session.value }
  });
  const request3 = await app.inject({
    method: "GET",
    url: "/me/unread",
    cookies: { bridge_session: session.value }
  });

  assert.equal(request1.statusCode, 200);
  assert.equal(request2.statusCode, 200);
  assert.equal(request3.statusCode, 429);
});
