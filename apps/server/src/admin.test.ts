import assert from "node:assert/strict";
import test from "node:test";
import { createBridgeApp } from "./app.js";
import { resetStore } from "./store.js";

async function makeApp() {
  resetStore();
  const { app } = await createBridgeApp("http://localhost:5173");
  return app;
}

test("admin endpoints reject non-admin users", async (t) => {
  const app = await makeApp();
  t.after(async () => {
    await app.close();
  });

  const response = await app.inject({
    method: "GET",
    url: "/admin/overview",
    headers: { "x-user-id": "u-3" }
  });

  assert.equal(response.statusCode, 403);
  assert.match(response.body, /admin role required/i);
});

test("admins can create and manage users", async (t) => {
  const app = await makeApp();
  t.after(async () => {
    await app.close();
  });

  const invite = await app.inject({
    method: "POST",
    url: "/admin/users",
    headers: { "x-user-id": "u-1" },
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
    headers: { "x-user-id": "u-1" },
    payload: { role: "manager" }
  });
  assert.equal(roleUpdate.statusCode, 200);
  assert.equal(roleUpdate.json().user.role, "manager");

  const statusUpdate = await app.inject({
    method: "PATCH",
    url: `/admin/users/${invited.id}/status`,
    headers: { "x-user-id": "u-1" },
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

  const createChannel = await app.inject({
    method: "POST",
    url: "/admin/channels",
    headers: { "x-user-id": "u-2" },
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
    headers: { "x-user-id": "u-2" },
    payload: { archived: true }
  });
  assert.equal(archiveChannel.statusCode, 200);
  assert.ok(archiveChannel.json().channel.archivedAt);

  const updateSettings = await app.inject({
    method: "PATCH",
    url: "/admin/settings",
    headers: { "x-user-id": "u-2" },
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
