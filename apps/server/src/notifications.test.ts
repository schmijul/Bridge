import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createBridgeApp } from "./app.js";
import { initAuth } from "./auth.js";
import { addMessage, createDirectConversation, resetStore, users } from "./store.js";

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

test("mention and dm activity create notifications and support read transitions", async (t) => {
  const app = await makeApp();
  t.after(async () => {
    await app.close();
  });

  const ninaSession = await loginAs(app, "nina@bridge.local", "bridge123!");
  addMessage("c-general", "u-2", "Heads up @Nina, the rollout is ready.", {
    mentionUserIds: ["u-3"]
  });
  const dm = createDirectConversation("u-1", ["u-3"]);
  addMessage(dm.channel.id, "u-1", "Private follow-up for Nina");

  const notifications = await app.inject({
    method: "GET",
    url: "/notifications",
    cookies: { bridge_session: ninaSession }
  });
  assert.equal(notifications.statusCode, 200);
  const body = notifications.json() as {
    unreadCount: number;
    totalCount: number;
    notifications: Array<{
      type: string;
      actorDisplayName: string;
      channelName: string;
      isUnread: boolean;
      messageContent: string | null;
    }>;
  };
  assert.equal(body.totalCount, 2);
  assert.equal(body.unreadCount, 2);
  assert.deepEqual(
    body.notifications.map((notification) => notification.type).sort(),
    ["direct_message", "mention"]
  );
  assert.ok(body.notifications.every((notification) => notification.isUnread));
  assert.ok(body.notifications.some((notification) => notification.actorDisplayName === "Alex"));
  assert.ok(body.notifications.some((notification) => notification.channelName === "general"));
  assert.ok(body.notifications.some((notification) => notification.messageContent?.includes("Nina")));

  const markRead = await app.inject({
    method: "POST",
    url: "/notifications/read",
    cookies: { bridge_session: ninaSession },
    payload: { all: true }
  });
  assert.equal(markRead.statusCode, 200);
  assert.equal(markRead.json().updatedCount, 2);
  assert.equal(markRead.json().unreadCount, 0);
  assert.ok(markRead.json().notifications.every((notification: { isUnread: boolean }) => !notification.isUnread));

  const afterRead = await app.inject({
    method: "GET",
    url: "/notifications",
    cookies: { bridge_session: ninaSession }
  });
  assert.equal(afterRead.statusCode, 200);
  assert.equal(afterRead.json().unreadCount, 0);
});

test("notification preferences control delivery and persist updates", async (t) => {
  const app = await makeApp();
  t.after(async () => {
    await app.close();
  });

  const ninaSession = await loginAs(app, "nina@bridge.local", "bridge123!");

  const prefsUpdate = await app.inject({
    method: "PATCH",
    url: "/notifications/preferences",
    cookies: { bridge_session: ninaSession },
    payload: {
      mentionEnabled: false,
      directMessageEnabled: true
    }
  });
  assert.equal(prefsUpdate.statusCode, 200);
  assert.equal(prefsUpdate.json().preferences.mentionEnabled, false);
  assert.equal(prefsUpdate.json().preferences.directMessageEnabled, true);

  addMessage("c-general", "u-2", "Muted mention @Nina", { mentionUserIds: ["u-3"] });
  const dm = createDirectConversation("u-1", ["u-3"]);
  addMessage(dm.channel.id, "u-1", "DM stays enabled");

  const notifications = await app.inject({
    method: "GET",
    url: "/notifications",
    cookies: { bridge_session: ninaSession }
  });
  assert.equal(notifications.statusCode, 200);
  const body = notifications.json() as {
    totalCount: number;
    unreadCount: number;
    notifications: Array<{ type: string }>;
    preferences: { mentionEnabled: boolean; directMessageEnabled: boolean };
  };
  assert.equal(body.preferences.mentionEnabled, false);
  assert.equal(body.preferences.directMessageEnabled, true);
  assert.equal(body.totalCount, 1);
  assert.equal(body.unreadCount, 1);
  assert.deepEqual(body.notifications.map((notification) => notification.type), ["direct_message"]);

  const prefsRead = await app.inject({
    method: "GET",
    url: "/notifications/preferences",
    cookies: { bridge_session: ninaSession }
  });
  assert.equal(prefsRead.statusCode, 200);
  assert.equal(prefsRead.json().preferences.mentionEnabled, false);
  assert.equal(prefsRead.json().preferences.directMessageEnabled, true);
});

test("delivery queue exposes admin status and can deliver notifications via webhook runner", async (t) => {
  const previous = {
    enabled: process.env.PUSH_DELIVERY_ENABLED,
    webhookUrl: process.env.PUSH_DELIVERY_WEBHOOK_URL,
    pollInterval: process.env.PUSH_DELIVERY_POLL_INTERVAL_MS
  };
  const receivedPayloads: Array<{ notificationId: string; userId: string; type: string }> = [];
  const server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end("method not allowed");
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      receivedPayloads.push(JSON.parse(body) as { notificationId: string; userId: string; type: string });
      res.statusCode = 202;
      res.end("accepted");
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  process.env.PUSH_DELIVERY_ENABLED = "true";
  process.env.PUSH_DELIVERY_WEBHOOK_URL = `http://127.0.0.1:${address.port}/push`;
  process.env.PUSH_DELIVERY_POLL_INTERVAL_MS = "600000";

  const app = await makeApp();
  t.after(async () => {
    await app.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    if (previous.enabled === undefined) {
      delete process.env.PUSH_DELIVERY_ENABLED;
    } else {
      process.env.PUSH_DELIVERY_ENABLED = previous.enabled;
    }
    if (previous.webhookUrl === undefined) {
      delete process.env.PUSH_DELIVERY_WEBHOOK_URL;
    } else {
      process.env.PUSH_DELIVERY_WEBHOOK_URL = previous.webhookUrl;
    }
    if (previous.pollInterval === undefined) {
      delete process.env.PUSH_DELIVERY_POLL_INTERVAL_MS;
    } else {
      process.env.PUSH_DELIVERY_POLL_INTERVAL_MS = previous.pollInterval;
    }
  });

  const ninaSession = await loginAs(app, "nina@bridge.local", "bridge123!");
  const alexSession = await loginAs(app, "alex@bridge.local", "bridge123!");
  addMessage("c-general", "u-2", "Heads up @Nina, please review.", {
    mentionUserIds: ["u-3"]
  });
  const dm = createDirectConversation("u-1", ["u-3"]);
  addMessage(dm.channel.id, "u-1", "Delivery queue DM");

  const statusBefore = await app.inject({
    method: "GET",
    url: "/admin/notifications/delivery",
    cookies: { bridge_session: alexSession }
  });
  assert.equal(statusBefore.statusCode, 200);
  assert.equal(statusBefore.json().enabled, true);
  assert.equal(statusBefore.json().stats.pendingCount, 2);

  const run = await app.inject({
    method: "POST",
    url: "/admin/notifications/delivery/run",
    cookies: { bridge_session: alexSession }
  });
  assert.equal(run.statusCode, 200);
  assert.equal(run.json().result.claimed, 2);
  assert.equal(run.json().result.delivered, 2);
  assert.equal(run.json().status.stats.pendingCount, 0);
  assert.equal(run.json().status.stats.deliveredCount, 2);

  assert.equal(receivedPayloads.length, 2);
  assert.ok(receivedPayloads.every((entry) => entry.userId === "u-3"));
  assert.deepEqual(
    receivedPayloads.map((entry) => entry.type).sort(),
    ["direct_message", "mention"]
  );

  const notificationsAfter = await app.inject({
    method: "GET",
    url: "/notifications",
    cookies: { bridge_session: ninaSession }
  });
  assert.equal(notificationsAfter.statusCode, 200);
  assert.equal(notificationsAfter.json().unreadCount, 2);
});
