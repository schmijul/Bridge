import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createBridgeApp } from "./app.js";
import { initAuth } from "./auth.js";
import { addMessage, resetStore, users } from "./store.js";

function buildMultipartBody(input: {
  boundary: string;
  channelId: string;
  threadRootMessageId?: string;
  filename: string;
  mimeType: string;
  content: Buffer;
}): Buffer {
  const lines: Buffer[] = [];
  const push = (value: string) => lines.push(Buffer.from(value, "utf8"));
  push(`--${input.boundary}\r\n`);
  push(`Content-Disposition: form-data; name="channelId"\r\n\r\n`);
  push(`${input.channelId}\r\n`);
  if (input.threadRootMessageId) {
    push(`--${input.boundary}\r\n`);
    push(`Content-Disposition: form-data; name="threadRootMessageId"\r\n\r\n`);
    push(`${input.threadRootMessageId}\r\n`);
  }
  push(`--${input.boundary}\r\n`);
  push(`Content-Disposition: form-data; name="file"; filename="${input.filename}"\r\n`);
  push(`Content-Type: ${input.mimeType}\r\n\r\n`);
  lines.push(input.content);
  push("\r\n");
  push(`--${input.boundary}--\r\n`);
  return Buffer.concat(lines);
}

async function makeApp(suffix: string) {
  resetStore();
  await initAuth(users);
  const uploadDir = join(process.cwd(), `.bridge_uploads_test_${suffix}`);
  process.env.ATTACHMENT_STORAGE_DRIVER = "local";
  process.env.ATTACHMENT_LOCAL_DIR = uploadDir;
  const { app } = await createBridgeApp("http://localhost:5173");
  return { app, uploadDir };
}

async function loginAs(
  app: Awaited<ReturnType<typeof makeApp>>["app"],
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

test("upload endpoint requires authentication", async (t) => {
  const { app, uploadDir } = await makeApp("auth");
  t.after(async () => {
    await app.close();
    await rm(uploadDir, { recursive: true, force: true });
  });

  const boundary = "boundary-auth";
  const body = buildMultipartBody({
    boundary,
    channelId: "c-general",
    filename: "hello.txt",
    mimeType: "text/plain",
    content: Buffer.from("hello")
  });
  const response = await app.inject({
    method: "POST",
    url: "/attachments",
    payload: body,
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`
    }
  });
  assert.equal(response.statusCode, 401);
});

test("uploaded attachment can be linked into a message and downloaded", async (t) => {
  const { app, uploadDir } = await makeApp("bind");
  t.after(async () => {
    await app.close();
    await rm(uploadDir, { recursive: true, force: true });
  });

  const sessionId = await loginAs(app, "alex@bridge.local", "bridge123!");
  const boundary = "boundary-bind";
  const content = Buffer.from("attachment body");
  const uploadBody = buildMultipartBody({
    boundary,
    channelId: "c-general",
    filename: "notes.txt",
    mimeType: "text/plain",
    content
  });
  const upload = await app.inject({
    method: "POST",
    url: "/attachments",
    cookies: { bridge_session: sessionId },
    payload: uploadBody,
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`
    }
  });
  assert.equal(upload.statusCode, 201);
  const attachmentId = upload.json().attachment.id as string;

  addMessage("c-general", "u-1", "See attached", { attachmentIds: [attachmentId] });

  const bootstrap = await app.inject({
    method: "GET",
    url: "/bootstrap",
    cookies: { bridge_session: sessionId }
  });
  assert.equal(bootstrap.statusCode, 200);
  const matching = bootstrap
    .json()
    .messages.find((message: { content: string; attachments?: Array<{ id: string }> }) => message.content === "See attached");
  assert.ok(matching);
  assert.equal(matching.attachments?.length, 1);
  assert.equal(matching.attachments?.[0]?.id, attachmentId);

  const download = await app.inject({
    method: "GET",
    url: `/attachments/${attachmentId}/download`,
    cookies: { bridge_session: sessionId }
  });
  assert.equal(download.statusCode, 200);
  assert.equal(download.body, content.toString("utf8"));
});

test("policy rejects blocked extension and supports pending removal", async (t) => {
  const { app, uploadDir } = await makeApp("policy");
  t.after(async () => {
    await app.close();
    await rm(uploadDir, { recursive: true, force: true });
  });

  const sessionId = await loginAs(app, "alex@bridge.local", "bridge123!");
  const blockedBoundary = "boundary-blocked";
  const blockedBody = buildMultipartBody({
    boundary: blockedBoundary,
    channelId: "c-general",
    filename: "danger.exe",
    mimeType: "application/octet-stream",
    content: Buffer.from("noop")
  });
  const blocked = await app.inject({
    method: "POST",
    url: "/attachments",
    cookies: { bridge_session: sessionId },
    payload: blockedBody,
    headers: {
      "content-type": `multipart/form-data; boundary=${blockedBoundary}`
    }
  });
  assert.equal(blocked.statusCode, 400);

  const okBoundary = "boundary-ok";
  const okBody = buildMultipartBody({
    boundary: okBoundary,
    channelId: "c-general",
    filename: "readme.txt",
    mimeType: "text/plain",
    content: Buffer.from("ok")
  });
  const uploaded = await app.inject({
    method: "POST",
    url: "/attachments",
    cookies: { bridge_session: sessionId },
    payload: okBody,
    headers: {
      "content-type": `multipart/form-data; boundary=${okBoundary}`
    }
  });
  assert.equal(uploaded.statusCode, 201);
  const attachmentId = uploaded.json().attachment.id as string;

  const removed = await app.inject({
    method: "DELETE",
    url: `/attachments/${attachmentId}`,
    cookies: { bridge_session: sessionId }
  });
  assert.equal(removed.statusCode, 200);

  const missing = await app.inject({
    method: "GET",
    url: `/attachments/${attachmentId}/download`,
    cookies: { bridge_session: sessionId }
  });
  assert.equal(missing.statusCode, 404);
});
