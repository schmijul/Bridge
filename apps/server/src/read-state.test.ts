import assert from "node:assert/strict";
import test from "node:test";
import { createBridgeApp } from "./app.js";
import { initAuth } from "./auth.js";
import { addMessage, messages, resetStore, setReadState, users } from "./store.js";

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

test("message metadata supports threads and mentions", async () => {
  resetStore();
  const event = addMessage("c-general", "u-1", "Ping @nina in thread", {
    threadRootMessageId: "m-1",
    mentionUserIds: ["u-3"]
  });
  assert.equal(event.type, "message:new");
  assert.equal(event.payload.threadRootMessageId, "m-1");
  assert.deepEqual(event.payload.mentionUserIds, ["u-3"]);
  assert.equal(messages[messages.length - 1].threadRootMessageId, "m-1");
});

test("me unread endpoint requires auth", async (t) => {
  const app = await makeApp();
  t.after(async () => {
    await app.close();
  });

  const response = await app.inject({
    method: "GET",
    url: "/me/unread"
  });
  assert.equal(response.statusCode, 401);
});

test("unread counts exclude sender and update after read-state change", async (t) => {
  const app = await makeApp();
  t.after(async () => {
    await app.close();
  });

  const nina = await loginAs(app, "nina@bridge.local", "bridge123!");
  addMessage("c-general", "u-1", "First unread");
  addMessage("c-general", "u-2", "Second unread");

  const unreadBefore = await app.inject({
    method: "GET",
    url: "/me/unread",
    cookies: { bridge_session: nina }
  });
  assert.equal(unreadBefore.statusCode, 200);
  const generalBefore = unreadBefore
    .json()
    .channels.find((entry: { channelId: string; unreadCount: number }) => entry.channelId === "c-general");
  assert.equal(generalBefore.unreadCount, 7);

  addMessage("c-general", "u-3", "Own message should auto-mark read up to this point");
  const unreadAfterOwnMessage = await app.inject({
    method: "GET",
    url: "/me/unread",
    cookies: { bridge_session: nina }
  });
  const generalAfterOwnMessage = unreadAfterOwnMessage
    .json()
    .channels.find((entry: { channelId: string; unreadCount: number }) => entry.channelId === "c-general");
  assert.equal(generalAfterOwnMessage.unreadCount, 0);

  const latestGeneralMessageId = messages
    .filter((message) => message.channelId === "c-general")
    .at(-1)?.id as string;
  setReadState("u-3", "c-general", latestGeneralMessageId);

  const unreadAfter = await app.inject({
    method: "GET",
    url: "/me/unread",
    cookies: { bridge_session: nina }
  });
  const generalAfter = unreadAfter
    .json()
    .channels.find((entry: { channelId: string; unreadCount: number }) => entry.channelId === "c-general");
  assert.equal(generalAfter.unreadCount, 0);
});
