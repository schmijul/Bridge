import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createBridgeApp } from "./app.js";
import { initAuth } from "./auth.js";
import { createAttachmentStorage, parseAttachmentStorageConfig } from "./attachments.js";
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

async function makeApp(
  suffix: string,
  options?: {
    scanMode?: "none" | "command";
    scanCommand?: string;
    encryptionKey?: string;
  }
) {
  resetStore();
  await initAuth(users);
  const uploadDir = join(process.cwd(), `.bridge_uploads_test_${suffix}`);
  process.env.ATTACHMENT_STORAGE_DRIVER = "local";
  process.env.ATTACHMENT_LOCAL_DIR = uploadDir;
  if (options?.encryptionKey) {
    process.env.ATTACHMENT_ENCRYPTION_KEY = options.encryptionKey;
  } else {
    delete process.env.ATTACHMENT_ENCRYPTION_KEY;
  }
  process.env.ATTACHMENT_SCAN_MODE = options?.scanMode ?? "none";
  if (options?.scanCommand) {
    process.env.ATTACHMENT_SCAN_COMMAND = options.scanCommand;
  } else {
    delete process.env.ATTACHMENT_SCAN_COMMAND;
  }
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

test("encrypted attachment storage still works end to end", async (t) => {
  const { app, uploadDir } = await makeApp("encrypted", {
    encryptionKey: Buffer.alloc(32, 19).toString("hex")
  });
  t.after(async () => {
    await app.close();
    await rm(uploadDir, { recursive: true, force: true });
  });

  const sessionId = await loginAs(app, "alex@bridge.local", "bridge123!");
  const boundary = "boundary-encrypted";
  const content = Buffer.from("encrypted attachment body");
  const uploadBody = buildMultipartBody({
    boundary,
    channelId: "c-general",
    filename: "secret.txt",
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

  addMessage("c-general", "u-1", "Encrypted attachment attached", {
    attachmentIds: [attachmentId]
  });

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

test("scanner command can reject attachment payloads", async (t) => {
  const { app, uploadDir } = await makeApp("scanner", {
    scanMode: "command",
    scanCommand: "/bin/false"
  });
  t.after(async () => {
    await app.close();
    await rm(uploadDir, { recursive: true, force: true });
  });

  const sessionId = await loginAs(app, "alex@bridge.local", "bridge123!");
  const boundary = "boundary-scanner";
  const body = buildMultipartBody({
    boundary,
    channelId: "c-general",
    filename: "suspicious.txt",
    mimeType: "text/plain",
    content: Buffer.from("scanner should reject this")
  });
  const response = await app.inject({
    method: "POST",
    url: "/attachments",
    cookies: { bridge_session: sessionId },
    payload: body,
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`
    }
  });
  assert.equal(response.statusCode, 400);
  assert.match(response.body, /malware scanner/i);
});

test("webdav attachment storage uploads, reads and deletes via WebDAV semantics", async () => {
  const config = parseAttachmentStorageConfig({
    ATTACHMENT_STORAGE_DRIVER: "webdav",
    ATTACHMENT_WEBDAV_BASE_URL: "https://cloud.example.com/remote.php/dav/files/bridge/",
    ATTACHMENT_WEBDAV_USERNAME: "bridge-bot",
    ATTACHMENT_WEBDAV_APP_PASSWORD: "super-secret-token",
    ATTACHMENT_WEBDAV_PATH_PREFIX: "Bridge/attachments"
  });

  const stored = new Map<string, Buffer>();
  const calls: Array<{ method: string; url: string; headers: Record<string, string> }> = [];
  const fetchMock: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(
      new Headers(init?.headers).entries()
    ) as Record<string, string>;
    calls.push({ method, url, headers });
    const pathname = new URL(url).pathname;

    if (method === "MKCOL") {
      return new Response(null, { status: 201 });
    }
    if (method === "PUT") {
      const bodyValue = init?.body;
      let body: Buffer;
      if (bodyValue instanceof Uint8Array) {
        body = Buffer.from(bodyValue);
      } else if (typeof bodyValue === "string") {
        body = Buffer.from(bodyValue, "utf8");
      } else if (bodyValue instanceof ArrayBuffer) {
        body = Buffer.from(bodyValue);
      } else {
        throw new Error("unexpected PUT body type");
      }
      stored.set(pathname, body);
      return new Response(null, { status: 201 });
    }
    if (method === "GET") {
      const body = stored.get(pathname);
      if (!body) {
        return new Response("missing", { status: 404 });
      }
      return new Response(new Uint8Array(body), {
        status: 200,
        headers: {
          "content-type": "text/plain",
          "content-length": String(body.length)
        }
      });
    }
    if (method === "DELETE") {
      stored.delete(pathname);
      return new Response(null, { status: 204 });
    }
    return new Response("unexpected method", { status: 405 });
  };

  const storage = createAttachmentStorage(config, { fetch: fetchMock });
  const uploaded = await storage.upload({
    bytes: Buffer.from("webdav-body"),
    mimeType: "text/plain",
    originalName: "report.txt"
  });
  assert.match(uploaded.storageKey, /^Bridge\/attachments\/[0-9a-f-]+-report\.txt$/);

  const read = await storage.readByKey(uploaded.storageKey);
  const chunks: Buffer[] = [];
  for await (const chunk of read.stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  assert.equal(Buffer.concat(chunks).toString("utf8"), "webdav-body");
  assert.equal(read.mimeType, "text/plain");
  assert.equal(read.sizeBytes, "webdav-body".length);

  await storage.removeByKey(uploaded.storageKey);
  assert.equal(stored.has(new URL(calls.at(-1)?.url ?? "").pathname), false);

  assert.deepEqual(
    calls.map((entry) => entry.method),
    ["MKCOL", "MKCOL", "PUT", "GET", "DELETE"]
  );
  assert.match(calls[2]!.headers.authorization, /^Basic /);
  assert.equal(calls[2]!.headers["content-type"], "text/plain");
});
