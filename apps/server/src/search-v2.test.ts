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
      name: `search-private-${suffix}`,
      description: "Private search test channel",
      isPrivate: true
    }
  });
  assert.equal(response.statusCode, 201);
  return response.json().channel.id as string;
}

function messageCreatedAt(event: ReturnType<typeof addMessage>): string {
  if (event.type !== "message:new") {
    throw new Error(`expected message:new event, got ${event.type}`);
  }
  return event.payload.createdAt;
}

test("search results stay hidden from non-members", async (t) => {
  const app = await makeApp();
  t.after(async () => {
    await app.close();
  });

  const admin = await loginAs(app, "alex@bridge.local", "bridge123!");
  const nina = await loginAs(app, "nina@bridge.local", "bridge123!");
  const privateChannelId = await createPrivateChannel(app, admin, "acl");
  addMessage(privateChannelId, "u-1", "search-v2 private needle");

  const memberSearch = await app.inject({
    method: "GET",
    url: "/search/messages?q=needle&limit=10",
    cookies: { bridge_session: nina }
  });
  assert.equal(memberSearch.statusCode, 200);
  assert.equal(memberSearch.json().count, 0);
  assert.equal(memberSearch.json().total, 0);
  assert.equal(memberSearch.json().nextOffset, null);

  const adminSearch = await app.inject({
    method: "GET",
    url: "/search/messages?q=needle&limit=10",
    cookies: { bridge_session: admin }
  });
  assert.equal(adminSearch.statusCode, 200);
  assert.equal(adminSearch.json().count, 1);
  assert.equal(adminSearch.json().total, 1);
  assert.equal(adminSearch.json().results[0].channelId, privateChannelId);
});

test("search supports channel, sender, and time filters", async (t) => {
  const app = await makeApp();
  t.after(async () => {
    await app.close();
  });

  const admin = await loginAs(app, "alex@bridge.local", "bridge123!");
  const first = addMessage("c-general", "u-1", "search-v2 alpha");
  await new Promise((resolve) => setTimeout(resolve, 2));
  const second = addMessage("c-general", "u-2", "search-v2 beta");
  await new Promise((resolve) => setTimeout(resolve, 2));
  addMessage("c-product", "u-1", "search-v2 gamma");

  const exactChannelAndSender = await app.inject({
    method: "GET",
    url: "/search/messages?q=search-v2&channelId=c-general&fromUserId=u-1&limit=10",
    cookies: { bridge_session: admin }
  });
  assert.equal(exactChannelAndSender.statusCode, 200);
  assert.equal(exactChannelAndSender.json().count, 1);
  assert.equal(exactChannelAndSender.json().total, 1);
  assert.equal(exactChannelAndSender.json().results[0].content, "search-v2 alpha");

  const afterFirst = await app.inject({
    method: "GET",
    url: `/search/messages?q=search-v2&after=${encodeURIComponent(messageCreatedAt(first))}&limit=10`,
    cookies: { bridge_session: admin }
  });
  assert.equal(afterFirst.statusCode, 200);
  assert.equal(afterFirst.json().count, 2);
  assert.equal(afterFirst.json().total, 2);
  assert.deepEqual(
    afterFirst.json().results.map((message: { content: string }) => message.content),
    ["search-v2 gamma", "search-v2 beta"]
  );

  const beforeSecond = await app.inject({
    method: "GET",
    url: `/search/messages?q=search-v2&before=${encodeURIComponent(messageCreatedAt(second))}&limit=10`,
    cookies: { bridge_session: admin }
  });
  assert.equal(beforeSecond.statusCode, 200);
  assert.equal(beforeSecond.json().count, 1);
  assert.equal(beforeSecond.json().total, 1);
  assert.equal(beforeSecond.json().results[0].content, "search-v2 alpha");
});

test("search pagination returns deterministic metadata", async (t) => {
  const app = await makeApp();
  t.after(async () => {
    await app.close();
  });

  const admin = await loginAs(app, "alex@bridge.local", "bridge123!");
  addMessage("c-general", "u-1", "page-v2 delta");
  await new Promise((resolve) => setTimeout(resolve, 2));
  addMessage("c-general", "u-1", "page-v2 charlie");
  await new Promise((resolve) => setTimeout(resolve, 2));
  addMessage("c-general", "u-1", "page-v2 bravo");

  const firstPage = await app.inject({
    method: "GET",
    url: "/search/messages?q=page-v2&limit=2&offset=0",
    cookies: { bridge_session: admin }
  });
  assert.equal(firstPage.statusCode, 200);
  assert.equal(firstPage.json().count, 2);
  assert.equal(firstPage.json().total, 3);
  assert.equal(firstPage.json().offset, 0);
  assert.equal(firstPage.json().limit, 2);
  assert.equal(firstPage.json().nextOffset, 2);
  assert.equal(firstPage.json().hasMore, true);
  assert.deepEqual(
    firstPage.json().results.map((message: { content: string }) => message.content),
    ["page-v2 bravo", "page-v2 charlie"]
  );

  const secondPage = await app.inject({
    method: "GET",
    url: "/search/messages?q=page-v2&limit=2&offset=2",
    cookies: { bridge_session: admin }
  });
  assert.equal(secondPage.statusCode, 200);
  assert.equal(secondPage.json().count, 1);
  assert.equal(secondPage.json().total, 3);
  assert.equal(secondPage.json().offset, 2);
  assert.equal(secondPage.json().limit, 2);
  assert.equal(secondPage.json().nextOffset, null);
  assert.equal(secondPage.json().hasMore, false);
  assert.deepEqual(
    secondPage.json().results.map((message: { content: string }) => message.content),
    ["page-v2 delta"]
  );
});
