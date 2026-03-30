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

test("dm routes require authentication", async (t) => {
  const app = await makeApp();
  t.after(async () => {
    await app.close();
  });

  const list = await app.inject({ method: "GET", url: "/dm/conversations" });
  assert.equal(list.statusCode, 401);

  const create = await app.inject({
    method: "POST",
    url: "/dm/conversations",
    payload: { participantUserIds: ["u-3"] }
  });
  assert.equal(create.statusCode, 401);
});

test("creating a one-to-one dm is idempotent", async (t) => {
  const app = await makeApp();
  t.after(async () => {
    await app.close();
  });

  const alex = await loginAs(app, "alex@bridge.local", "bridge123!");

  const created = await app.inject({
    method: "POST",
    url: "/dm/conversations",
    cookies: { bridge_session: alex },
    payload: { participantUserIds: ["u-3"] }
  });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().conversation.kind, "dm");
  const firstId = created.json().conversation.id as string;

  const again = await app.inject({
    method: "POST",
    url: "/dm/conversations",
    cookies: { bridge_session: alex },
    payload: { participantUserIds: ["u-3", "u-3"] }
  });
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().conversation.id, firstId);
});

test("dm conversations are only visible to conversation members", async (t) => {
  const app = await makeApp();
  t.after(async () => {
    await app.close();
  });

  const alex = await loginAs(app, "alex@bridge.local", "bridge123!");
  const nina = await loginAs(app, "nina@bridge.local", "bridge123!");
  const sam = await loginAs(app, "sam@bridge.local", "bridge123!");

  const created = await app.inject({
    method: "POST",
    url: "/dm/conversations",
    cookies: { bridge_session: alex },
    payload: { participantUserIds: ["u-3"] }
  });
  const dmId = created.json().conversation.id as string;
  addMessage(dmId, "u-1", "This is a direct message secret.");

  const ninaList = await app.inject({
    method: "GET",
    url: "/dm/conversations",
    cookies: { bridge_session: nina }
  });
  assert.equal(
    ninaList.json().conversations.some((channel: { id: string }) => channel.id === dmId),
    true
  );

  const samList = await app.inject({
    method: "GET",
    url: "/dm/conversations",
    cookies: { bridge_session: sam }
  });
  assert.equal(
    samList.json().conversations.some((channel: { id: string }) => channel.id === dmId),
    false
  );

  const samSearch = await app.inject({
    method: "GET",
    url: "/search/messages?q=secret&limit=10",
    cookies: { bridge_session: sam }
  });
  assert.equal(samSearch.statusCode, 200);
  assert.equal(samSearch.json().count, 0);
});

test("group dm conversations are created with group_dm kind", async (t) => {
  const app = await makeApp();
  t.after(async () => {
    await app.close();
  });

  const alex = await loginAs(app, "alex@bridge.local", "bridge123!");
  const create = await app.inject({
    method: "POST",
    url: "/dm/conversations",
    cookies: { bridge_session: alex },
    payload: { participantUserIds: ["u-2", "u-3"] }
  });
  assert.equal(create.statusCode, 201);
  assert.equal(create.json().conversation.kind, "group_dm");
  assert.equal(create.json().participantIds.length, 3);
});

test("dm creation validates participant constraints", async (t) => {
  const app = await makeApp();
  t.after(async () => {
    await app.close();
  });

  const alex = await loginAs(app, "alex@bridge.local", "bridge123!");

  const missingUser = await app.inject({
    method: "POST",
    url: "/dm/conversations",
    cookies: { bridge_session: alex },
    payload: { participantUserIds: ["u-missing"] }
  });
  assert.equal(missingUser.statusCode, 404);

  const tooMany = await app.inject({
    method: "POST",
    url: "/dm/conversations",
    cookies: { bridge_session: alex },
    payload: { participantUserIds: Array.from({ length: 20 }, (_, index) => `u-${index}`) }
  });
  assert.equal(tooMany.statusCode, 400);
});
