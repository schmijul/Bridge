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

test("admins can create bots and receive a one-time token", async (t) => {
  const app = await makeApp();
  t.after(async () => {
    await app.close();
  });

  const sessionId = await loginAs(app, "alex@bridge.local", "bridge123!");
  const response = await app.inject({
    method: "POST",
    url: "/admin/bots",
    cookies: { bridge_session: sessionId },
    payload: {
      displayName: "Build Helper"
    }
  });

  assert.equal(response.statusCode, 201);
  const body = response.json() as {
    bot: { id: string; displayName: string; email: string; role: string; isBot?: boolean };
    token: string;
  };
  assert.equal(body.bot.displayName, "Build Helper");
  assert.equal(body.bot.role, "member");
  assert.equal(body.bot.isBot, true);
  assert.match(body.bot.email, /@/);
  assert.ok(body.token.length > 20);
});

test("bot tokens can post messages", async (t) => {
  const app = await makeApp();
  t.after(async () => {
    await app.close();
  });

  const sessionId = await loginAs(app, "alex@bridge.local", "bridge123!");
  const createBot = await app.inject({
    method: "POST",
    url: "/admin/bots",
    cookies: { bridge_session: sessionId },
    payload: {
      displayName: "Release Bot",
      role: "member"
    }
  });
  assert.equal(createBot.statusCode, 201);
  const botBody = createBot.json() as {
    bot: { id: string; displayName: string };
    token: string;
  };

  const posted = await app.inject({
    method: "POST",
    url: "/bots/messages",
    headers: { authorization: `Bearer ${botBody.token}` },
    payload: {
      channelId: "c-general",
      content: "Automated release note: the build is green."
    }
  });

  assert.equal(posted.statusCode, 201);
  const postedBody = posted.json() as {
    message: { senderId: string; channelId: string; content: string };
  };
  assert.equal(postedBody.message.senderId, botBody.bot.id);
  assert.equal(postedBody.message.channelId, "c-general");
  assert.equal(postedBody.message.content, "Automated release note: the build is green.");
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
