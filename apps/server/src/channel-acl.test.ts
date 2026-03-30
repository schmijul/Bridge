import assert from "node:assert/strict";
import test from "node:test";
import { createBridgeApp } from "./app.js";
import { initAuth } from "./auth.js";
import { addMessage, resetStore, users } from "./store.js";

async function makeApp() {
  resetStore();
  await initAuth(users);
  const { app } = await createBridgeApp("http://localhost:5173");
  return app;
}

async function loginAs(
  app: Awaited<ReturnType<typeof makeApp>>,
  email: string,
  password: string
): Promise<string> {
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

async function createPrivateChannel(
  app: Awaited<ReturnType<typeof makeApp>>,
  sessionId: string,
  suffix: string
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/admin/channels",
    cookies: { bridge_session: sessionId },
    payload: {
      name: `private-${suffix}`,
      description: "Private planning channel for ACL tests",
      isPrivate: true
    }
  });
  assert.equal(response.statusCode, 201);
  return response.json().channel.id as string;
}

test("bootstrap requires an authenticated session", async (t) => {
  const app = await makeApp();
  t.after(async () => {
    await app.close();
  });

  const response = await app.inject({
    method: "GET",
    url: "/bootstrap"
  });
  assert.equal(response.statusCode, 401);
});

test("private channels and messages stay hidden from non-members", async (t) => {
  const app = await makeApp();
  t.after(async () => {
    await app.close();
  });

  const adminSession = await loginAs(app, "alex@bridge.local", "bridge123!");
  const privateChannelId = await createPrivateChannel(app, adminSession, "hidden");
  addMessage(privateChannelId, "u-1", "Hydra launch details are private.");

  const memberSession = await loginAs(app, "nina@bridge.local", "bridge123!");
  const memberBootstrap = await app.inject({
    method: "GET",
    url: "/bootstrap",
    cookies: { bridge_session: memberSession }
  });
  assert.equal(memberBootstrap.statusCode, 200);
  assert.equal(
    memberBootstrap.json().channels.some((channel: { id: string }) => channel.id === privateChannelId),
    false
  );
  assert.equal(
    memberBootstrap
      .json()
      .messages.some((message: { channelId: string }) => message.channelId === privateChannelId),
    false
  );

  const memberSearch = await app.inject({
    method: "GET",
    url: "/search/messages?q=hydra&limit=10",
    cookies: { bridge_session: memberSession }
  });
  assert.equal(memberSearch.statusCode, 200);
  assert.equal(memberSearch.json().count, 0);

  const adminSearch = await app.inject({
    method: "GET",
    url: "/search/messages?q=hydra&limit=10",
    cookies: { bridge_session: adminSession }
  });
  assert.equal(adminSearch.statusCode, 200);
  assert.equal(adminSearch.json().count, 1);
});

test("admin can grant and revoke private channel membership", async (t) => {
  const app = await makeApp();
  t.after(async () => {
    await app.close();
  });

  const adminSession = await loginAs(app, "alex@bridge.local", "bridge123!");
  const memberSession = await loginAs(app, "nina@bridge.local", "bridge123!");
  const privateChannelId = await createPrivateChannel(app, adminSession, "manage");

  const beforeGrant = await app.inject({
    method: "GET",
    url: "/bootstrap",
    cookies: { bridge_session: memberSession }
  });
  assert.equal(
    beforeGrant.json().channels.some((channel: { id: string }) => channel.id === privateChannelId),
    false
  );

  const grant = await app.inject({
    method: "POST",
    url: `/admin/channels/${privateChannelId}/members`,
    cookies: { bridge_session: adminSession },
    payload: { userId: "u-3" }
  });
  assert.equal(grant.statusCode, 201);
  assert.equal(grant.json().members.includes("u-3"), true);

  const afterGrant = await app.inject({
    method: "GET",
    url: "/bootstrap",
    cookies: { bridge_session: memberSession }
  });
  assert.equal(
    afterGrant.json().channels.some((channel: { id: string }) => channel.id === privateChannelId),
    true
  );

  const revoke = await app.inject({
    method: "DELETE",
    url: `/admin/channels/${privateChannelId}/members/u-3`,
    cookies: { bridge_session: adminSession }
  });
  assert.equal(revoke.statusCode, 200);
  assert.equal(revoke.json().members.includes("u-3"), false);

  const afterRevoke = await app.inject({
    method: "GET",
    url: "/bootstrap",
    cookies: { bridge_session: memberSession }
  });
  assert.equal(
    afterRevoke.json().channels.some((channel: { id: string }) => channel.id === privateChannelId),
    false
  );
});

test("membership management rejects public channels and non-admin actors", async (t) => {
  const app = await makeApp();
  t.after(async () => {
    await app.close();
  });

  const adminSession = await loginAs(app, "alex@bridge.local", "bridge123!");
  const nonAdminSession = await loginAs(app, "nina@bridge.local", "bridge123!");
  const privateChannelId = await createPrivateChannel(app, adminSession, "roles");

  const publicChannelAttempt = await app.inject({
    method: "POST",
    url: "/admin/channels/c-general/members",
    cookies: { bridge_session: adminSession },
    payload: { userId: "u-3" }
  });
  assert.equal(publicChannelAttempt.statusCode, 400);

  const nonAdminAttempt = await app.inject({
    method: "POST",
    url: `/admin/channels/${privateChannelId}/members`,
    cookies: { bridge_session: nonAdminSession },
    payload: { userId: "u-3" }
  });
  assert.equal(nonAdminAttempt.statusCode, 403);
});

test("adding the same private member twice is idempotent", async (t) => {
  const app = await makeApp();
  t.after(async () => {
    await app.close();
  });

  const adminSession = await loginAs(app, "alex@bridge.local", "bridge123!");
  const privateChannelId = await createPrivateChannel(app, adminSession, "idempotent");

  const first = await app.inject({
    method: "POST",
    url: `/admin/channels/${privateChannelId}/members`,
    cookies: { bridge_session: adminSession },
    payload: { userId: "u-3" }
  });
  assert.equal(first.statusCode, 201);

  const second = await app.inject({
    method: "POST",
    url: `/admin/channels/${privateChannelId}/members`,
    cookies: { bridge_session: adminSession },
    payload: { userId: "u-3" }
  });
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().members.filter((id: string) => id === "u-3").length, 1);
});
