import assert from "node:assert/strict";
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
