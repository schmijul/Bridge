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

async function makeSecureApp() {
  resetStore();
  await initAuth(users);
  const { app } = await createBridgeApp("http://localhost:5173", {
    security: {
      sessionCookieSecure: true,
      sessionCookieSameSite: "strict"
    }
  });
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
      displayName: "Taylor",
      email: "taylor@bridge.local",
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

test("admin overview includes private channel memberships", async (t) => {
  const app = await makeApp();
  t.after(async () => {
    await app.close();
  });

  const sessionId = await loginAs(app, "alex@bridge.local", "bridge123!");
  const createChannel = await app.inject({
    method: "POST",
    url: "/admin/channels",
    cookies: { bridge_session: sessionId },
    payload: {
      name: "leadership",
      description: "Private leadership planning",
      isPrivate: true
    }
  });
  assert.equal(createChannel.statusCode, 201);
  const channelId = createChannel.json().channel.id as string;

  const grant = await app.inject({
    method: "POST",
    url: `/admin/channels/${channelId}/members`,
    cookies: { bridge_session: sessionId },
    payload: { userId: "u-3" }
  });
  assert.equal(grant.statusCode, 201);

  const overview = await app.inject({
    method: "GET",
    url: "/admin/overview",
    cookies: { bridge_session: sessionId }
  });
  assert.equal(overview.statusCode, 200);
  assert.deepEqual(overview.json().channelMembers[channelId].sort(), ["u-1", "u-3"]);
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
    url: "/search/messages?q=release%20freeze&limit=5",
    cookies: { bridge_session: cookie.value }
  });
  assert.equal(response.statusCode, 200);
  assert.ok(response.json().count >= 1);
});

test("auth login rotates an existing session", async (t) => {
  const app = await makeApp();
  t.after(async () => {
    await app.close();
  });

  const firstLogin = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: {
      email: "alex@bridge.local",
      password: "bridge123!"
    }
  });
  assert.equal(firstLogin.statusCode, 200);
  const firstCookie = firstLogin.cookies.find((entry) => entry.name === "bridge_session");
  assert.ok(firstCookie);

  const secondLogin = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: {
      email: "alex@bridge.local",
      password: "bridge123!"
    },
    cookies: { bridge_session: firstCookie.value }
  });
  assert.equal(secondLogin.statusCode, 200);
  const secondCookie = secondLogin.cookies.find((entry) => entry.name === "bridge_session");
  assert.ok(secondCookie);
  assert.notEqual(secondCookie.value, firstCookie.value);

  const meWithOldSession = await app.inject({
    method: "GET",
    url: "/auth/me",
    cookies: { bridge_session: firstCookie.value }
  });
  assert.equal(meWithOldSession.statusCode, 401);

  const meWithNewSession = await app.inject({
    method: "GET",
    url: "/auth/me",
    cookies: { bridge_session: secondCookie.value }
  });
  assert.equal(meWithNewSession.statusCode, 200);
});

test("updating user role revokes all sessions for that user", async (t) => {
  const app = await makeApp();
  t.after(async () => {
    await app.close();
  });

  const adminSession = await loginAs(app, "alex@bridge.local", "bridge123!");
  const memberSession = await loginAs(app, "nina@bridge.local", "bridge123!");

  const roleUpdate = await app.inject({
    method: "PATCH",
    url: "/admin/users/u-3/role",
    cookies: { bridge_session: adminSession },
    payload: { role: "guest" }
  });
  assert.equal(roleUpdate.statusCode, 200);

  const bootstrapAfterRoleChange = await app.inject({
    method: "GET",
    url: "/bootstrap",
    cookies: { bridge_session: memberSession }
  });
  assert.equal(bootstrapAfterRoleChange.statusCode, 401);
});

test("security headers and cookie flags are set on auth responses", async (t) => {
  const app = await makeSecureApp();
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
  assert.equal(login.headers["x-content-type-options"], "nosniff");
  assert.equal(login.headers["x-frame-options"], "DENY");
  assert.equal(login.headers["referrer-policy"], "no-referrer");
  assert.equal(login.headers["permissions-policy"], "camera=(), microphone=(), geolocation=()");
  assert.equal(
    login.headers["content-security-policy"],
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
  );
  assert.equal(login.headers["strict-transport-security"], "max-age=31536000; includeSubDomains");

  const setCookie = login.headers["set-cookie"];
  assert.equal(typeof setCookie, "string");
  if (typeof setCookie !== "string") {
    throw new Error("expected set-cookie header to be a single string");
  }
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /Secure/i);
  assert.match(setCookie, /SameSite=Strict/i);
});
