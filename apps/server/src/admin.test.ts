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

test("admin endpoints reject non-admin users", async (t) => {
  const app = await makeApp();
  t.after(async () => {
    await app.close();
  });

  const sessionId = await loginAs(app, "nina@bridge.local", "bridge123!");
  const response = await app.inject({
    method: "GET",
    url: "/admin/overview",
    cookies: { bridge_session: sessionId }
  });

  assert.equal(response.statusCode, 403);
  assert.match(response.body, /admin role required/i);
});

test("admins can create and manage users", async (t) => {
  const app = await makeApp();
  t.after(async () => {
    await app.close();
  });

  const sessionId = await loginAs(app, "alex@bridge.local", "bridge123!");
  const invite = await app.inject({
    method: "POST",
    url: "/admin/users",
    cookies: { bridge_session: sessionId },
    payload: {
      displayName: "Jordan",
      email: "jordan@bridge.local",
      role: "member"
    }
  });
  assert.equal(invite.statusCode, 201);
  const invited = invite.json().user as { id: string; role: string; isActive: boolean };
  assert.equal(invited.role, "member");
  assert.equal(invited.isActive, true);

  const roleUpdate = await app.inject({
    method: "PATCH",
    url: `/admin/users/${invited.id}/role`,
    cookies: { bridge_session: sessionId },
    payload: { role: "manager" }
  });
  assert.equal(roleUpdate.statusCode, 200);
  assert.equal(roleUpdate.json().user.role, "manager");

  const statusUpdate = await app.inject({
    method: "PATCH",
    url: `/admin/users/${invited.id}/status`,
    cookies: { bridge_session: sessionId },
    payload: { isActive: false }
  });
  assert.equal(statusUpdate.statusCode, 200);
  assert.equal(statusUpdate.json().user.isActive, false);
});

test("admins can create channels and adjust workspace settings", async (t) => {
  const app = await makeApp();
  t.after(async () => {
    await app.close();
  });

  const sessionId = await loginAs(app, "sam@bridge.local", "bridge123!");
  const createChannel = await app.inject({
    method: "POST",
    url: "/admin/channels",
    cookies: { bridge_session: sessionId },
    payload: {
      name: "engineering",
      description: "Engineering planning and release work",
      isPrivate: false
    }
  });
  assert.equal(createChannel.statusCode, 201);
  const channelId = createChannel.json().channel.id as string;

  const archiveChannel = await app.inject({
    method: "PATCH",
    url: `/admin/channels/${channelId}`,
    cookies: { bridge_session: sessionId },
    payload: { archived: true }
  });
  assert.equal(archiveChannel.statusCode, 200);
  assert.ok(archiveChannel.json().channel.archivedAt);

  const updateSettings = await app.inject({
    method: "PATCH",
    url: "/admin/settings",
    cookies: { bridge_session: sessionId },
    payload: {
      workspaceName: "Bridge Enterprise",
      messageRetentionDays: 730,
      allowGuestAccess: true,
      enforceMfaForAdmins: true
    }
  });
  assert.equal(updateSettings.statusCode, 200);
  assert.equal(updateSettings.json().workspace.settings.workspaceName, "Bridge Enterprise");
});

test("auth login issues a cookie and allows admin access", async (t) => {
  const app = await makeApp();
  t.after(async () => {
    await app.close();
  });

  const login = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: {
      email: "alex@bridge.local",
      password: "bridge123!"
    }
  });
  assert.equal(login.statusCode, 200);
  const cookie = login.cookies.find((entry) => entry.name === "bridge_session");
  assert.ok(cookie);

  const overview = await app.inject({
    method: "GET",
    url: "/admin/overview",
    cookies: {
      bridge_session: cookie.value
    }
  });
  assert.equal(overview.statusCode, 200);
});

test("authenticated users can search messages", async (t) => {
  const app = await makeApp();
  t.after(async () => {
    await app.close();
  });

  const login = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: {
      email: "alex@bridge.local",
      password: "bridge123!"
    }
  });
  assert.equal(login.statusCode, 200);
  const cookie = login.cookies.find((entry) => entry.name === "bridge_session");
  assert.ok(cookie);

  const response = await app.inject({
    method: "GET",
    url: "/search/messages?q=release&limit=5",
    cookies: { bridge_session: cookie.value }
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().count, 1);
});
