import assert from "node:assert/strict";
import test from "node:test";
import { createBridgeApp } from "./app.js";
import { initAuth } from "./auth.js";
import { resetStore, users } from "./store.js";

async function makeApp() {
  resetStore();
  await initAuth(users);
  const { app } = await createBridgeApp("http://localhost:5173");
  return app;
}

async function loginAs(app: Awaited<ReturnType<typeof makeApp>>, email: string, password: string) {
  const login = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email, password }
  });
  assert.equal(login.statusCode, 200);
  const cookie = login.cookies.find((entry) => entry.name === "bridge_session");
  assert.ok(cookie);
  return cookie.value;
}

async function createBot(
  app: Awaited<ReturnType<typeof makeApp>>,
  sessionId: string,
  displayName = "Build Helper"
) {
  const response = await app.inject({
    method: "POST",
    url: "/admin/bots",
    cookies: { bridge_session: sessionId },
    payload: { displayName }
  });

  assert.equal(response.statusCode, 201);
  return response.json() as {
    bot: {
      id: string;
      displayName: string;
      email: string;
      role: string;
      isBot?: boolean;
      activeTokenCount: number;
      lastTokenCreatedAt: string | null;
    };
    token: string;
  };
}

test("admins can create bots and receive a one-time token", async (t) => {
  const app = await makeApp();
  t.after(async () => {
    await app.close();
  });

  const sessionId = await loginAs(app, "alex@bridge.local", "bridge123!");
  const body = await createBot(app, sessionId);

  assert.equal(body.bot.displayName, "Build Helper");
  assert.equal(body.bot.role, "member");
  assert.equal(body.bot.isBot, true);
  assert.equal(body.bot.activeTokenCount, 1);
  assert.ok(body.bot.lastTokenCreatedAt);
  assert.match(body.bot.email, /@/);
  assert.ok(body.token.length > 20);
});

test("admins can list bots without exposing token material", async (t) => {
  const app = await makeApp();
  t.after(async () => {
    await app.close();
  });

  const sessionId = await loginAs(app, "alex@bridge.local", "bridge123!");
  const created = await createBot(app, sessionId, "Release Bot");
  const listed = await app.inject({
    method: "GET",
    url: "/admin/bots",
    cookies: { bridge_session: sessionId }
  });

  assert.equal(listed.statusCode, 200);
  const body = listed.json() as {
    bots: Array<{
      id: string;
      displayName: string;
      activeTokenCount: number;
      lastTokenCreatedAt: string | null;
      token?: string;
    }>;
  };
  const bot = body.bots.find((entry) => entry.id === created.bot.id);
  assert.ok(bot);
  assert.equal(bot?.displayName, "Release Bot");
  assert.equal(bot?.activeTokenCount, 1);
  assert.ok(bot?.lastTokenCreatedAt);
  assert.equal(bot && "token" in bot ? bot.token : undefined, undefined);
});

test("bot tokens can be rotated and old tokens stop working", async (t) => {
  const app = await makeApp();
  t.after(async () => {
    await app.close();
  });

  const sessionId = await loginAs(app, "alex@bridge.local", "bridge123!");
  const created = await createBot(app, sessionId, "Delivery Bot");
  const rotated = await app.inject({
    method: "POST",
    url: `/admin/bots/${created.bot.id}/token`,
    cookies: { bridge_session: sessionId }
  });

  assert.equal(rotated.statusCode, 200);
  const rotatedBody = rotated.json() as {
    bot: { id: string; activeTokenCount: number; lastTokenCreatedAt: string | null };
    token: string;
  };
  assert.equal(rotatedBody.bot.id, created.bot.id);
  assert.equal(rotatedBody.bot.activeTokenCount, 1);
  assert.ok(rotatedBody.bot.lastTokenCreatedAt);
  assert.notEqual(rotatedBody.token, created.token);

  const oldTokenPost = await app.inject({
    method: "POST",
    url: "/bots/messages",
    headers: { authorization: `Bearer ${created.token}` },
    payload: {
      channelId: "c-general",
      content: "The old token should no longer work."
    }
  });
  assert.equal(oldTokenPost.statusCode, 401);
  assert.match(oldTokenPost.body, /invalid bot token/i);

  const newTokenPost = await app.inject({
    method: "POST",
    url: "/bots/messages",
    headers: { authorization: `Bearer ${rotatedBody.token}` },
    payload: {
      channelId: "c-general",
      content: "The rotated token is active."
    }
  });
  assert.equal(newTokenPost.statusCode, 201);
});

test("bot token revocation invalidates active tokens and clears summary counts", async (t) => {
  const app = await makeApp();
  t.after(async () => {
    await app.close();
  });

  const sessionId = await loginAs(app, "alex@bridge.local", "bridge123!");
  const created = await createBot(app, sessionId, "Ops Bot");
  const revoked = await app.inject({
    method: "DELETE",
    url: `/admin/bots/${created.bot.id}/token`,
    cookies: { bridge_session: sessionId }
  });

  assert.equal(revoked.statusCode, 200);
  const revokedBody = revoked.json() as {
    bot: { id: string; activeTokenCount: number; lastTokenCreatedAt: string | null };
    revokedTokenCount: number;
  };
  assert.equal(revokedBody.bot.id, created.bot.id);
  assert.equal(revokedBody.revokedTokenCount, 1);
  assert.equal(revokedBody.bot.activeTokenCount, 0);
  assert.equal(revokedBody.bot.lastTokenCreatedAt, null);

  const listed = await app.inject({
    method: "GET",
    url: "/admin/bots",
    cookies: { bridge_session: sessionId }
  });
  assert.equal(listed.statusCode, 200);
  const listBody = listed.json() as {
    bots: Array<{ id: string; activeTokenCount: number; lastTokenCreatedAt: string | null }>;
  };
  const bot = listBody.bots.find((entry) => entry.id === created.bot.id);
  assert.ok(bot);
  assert.equal(bot?.activeTokenCount, 0);
  assert.equal(bot?.lastTokenCreatedAt, null);

  const postAfterRevoke = await app.inject({
    method: "POST",
    url: "/bots/messages",
    headers: { authorization: `Bearer ${created.token}` },
    payload: {
      channelId: "c-general",
      content: "This should be rejected after revocation."
    }
  });
  assert.equal(postAfterRevoke.statusCode, 401);
  assert.match(postAfterRevoke.body, /invalid bot token/i);
});

test("invalid bot tokens are rejected", async (t) => {
  const app = await makeApp();
  t.after(async () => {
    await app.close();
  });

  const response = await app.inject({
    method: "POST",
    url: "/bots/messages",
    headers: { authorization: "Bearer definitely-invalid" },
    payload: {
      channelId: "c-general",
      content: "This should not post"
    }
  });

  assert.equal(response.statusCode, 401);
  assert.match(response.body, /invalid bot token/i);
});

test("non-admin users cannot create bots", async (t) => {
  const app = await makeApp();
  t.after(async () => {
    await app.close();
  });

  const sessionId = await loginAs(app, "nina@bridge.local", "bridge123!");
  const response = await app.inject({
    method: "POST",
    url: "/admin/bots",
    cookies: { bridge_session: sessionId },
    payload: {
      displayName: "Support Bot"
    }
  });

  assert.equal(response.statusCode, 403);
  assert.match(response.body, /admin role required/i);
});
