import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { GetObjectCommand, PutObjectCommand, DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";

const execFileAsync = promisify(execFile);

export type AttachmentUploadInput = {
  bytes: Buffer;
  mimeType: string;
  originalName: string;
};

export type StoredAttachment = {
  storageKey: string;
  sizeBytes: number;
};

export type AttachmentStorage = {
  upload: (input: AttachmentUploadInput) => Promise<StoredAttachment>;
  removeByKey: (storageKey: string) => Promise<void>;
  readByKey: (storageKey: string) => Promise<{ stream: Readable; sizeBytes?: number; mimeType?: string }>;
};

export type AttachmentScanResult = {
  ok: boolean;
  detail: string;
};

export type AttachmentScanner = {
  scan: (input: AttachmentUploadInput) => Promise<AttachmentScanResult>;
};

type LocalStorageConfig = {
  driver: "local";
  rootDir: string;
};

type S3StorageConfig = {
  driver: "s3";
  bucket: string;
  keyPrefix: string;
  endpoint?: string;
  forcePathStyle: boolean;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
};

type WebDavStorageConfig = {
  driver: "webdav";
  baseUrl: string;
  username: string;
  appPassword: string;
  pathPrefix: string;
};

export type AttachmentStorageConfig = LocalStorageConfig | S3StorageConfig | WebDavStorageConfig;

type NoopScannerConfig = {
  mode: "none";
};

type CommandScannerConfig = {
  mode: "command";
  command: string;
  timeoutMs: number;
};

export type AttachmentScannerConfig = NoopScannerConfig | CommandScannerConfig;

export type AttachmentStorageDependencies = {
  fetch?: typeof fetch;
};

export function parseBlockedExtensions(raw: string | undefined): Set<string> {
  const fallback = ["bat", "cmd", "com", "cpl", "exe", "js", "mjs", "cjs", "msi", "ps1", "scr", "sh", "vbs"];
  const values = (raw ?? fallback.join(","))
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)
    .map((entry) => entry.replace(/^\./, ""));
  return new Set(values);
}

export function parseAttachmentStorageConfig(env: NodeJS.ProcessEnv): AttachmentStorageConfig {
  const driver = (env.ATTACHMENT_STORAGE_DRIVER ?? "local").trim().toLowerCase();
  if (driver === "s3") {
    if (!env.ATTACHMENT_S3_BUCKET || !env.ATTACHMENT_S3_ACCESS_KEY_ID || !env.ATTACHMENT_S3_SECRET_ACCESS_KEY) {
      throw new Error(
        "ATTACHMENT_STORAGE_DRIVER=s3 requires ATTACHMENT_S3_BUCKET, ATTACHMENT_S3_ACCESS_KEY_ID and ATTACHMENT_S3_SECRET_ACCESS_KEY"
      );
    }
    return {
      driver: "s3",
      bucket: env.ATTACHMENT_S3_BUCKET,
      keyPrefix: (env.ATTACHMENT_S3_KEY_PREFIX ?? "bridge/uploads").replace(/^\/+|\/+$/g, ""),
      endpoint: env.ATTACHMENT_S3_ENDPOINT,
      forcePathStyle: (env.ATTACHMENT_S3_FORCE_PATH_STYLE ?? "true").trim().toLowerCase() === "true",
      region: env.ATTACHMENT_S3_REGION ?? "us-east-1",
      accessKeyId: env.ATTACHMENT_S3_ACCESS_KEY_ID,
      secretAccessKey: env.ATTACHMENT_S3_SECRET_ACCESS_KEY
    };
  }
  if (driver === "webdav") {
    if (!env.ATTACHMENT_WEBDAV_BASE_URL || !env.ATTACHMENT_WEBDAV_USERNAME || !env.ATTACHMENT_WEBDAV_APP_PASSWORD) {
      throw new Error(
        "ATTACHMENT_STORAGE_DRIVER=webdav requires ATTACHMENT_WEBDAV_BASE_URL, ATTACHMENT_WEBDAV_USERNAME and ATTACHMENT_WEBDAV_APP_PASSWORD"
      );
    }
    const username = env.ATTACHMENT_WEBDAV_USERNAME.trim();
    const appPassword = env.ATTACHMENT_WEBDAV_APP_PASSWORD.trim();
    if (!username || !appPassword) {
      throw new Error(
        "ATTACHMENT_STORAGE_DRIVER=webdav requires non-empty ATTACHMENT_WEBDAV_USERNAME and ATTACHMENT_WEBDAV_APP_PASSWORD"
      );
    }
    const allowInsecureWebDav = (env.ATTACHMENT_WEBDAV_ALLOW_INSECURE ?? "false").trim().toLowerCase() === "true";
    const baseUrl = validateWebDavBaseUrl(env.ATTACHMENT_WEBDAV_BASE_URL, allowInsecureWebDav);
    const pathPrefix = normalizePathPrefix(env.ATTACHMENT_WEBDAV_PATH_PREFIX ?? "bridge/attachments");
    validateWebDavPathPrefix(pathPrefix);
    return {
      driver: "webdav",
      baseUrl,
      username,
      appPassword,
      pathPrefix
    };
  }
  return {
    driver: "local",
    rootDir: env.ATTACHMENT_LOCAL_DIR ?? join(process.cwd(), ".bridge_uploads")
  };
}

export function parseAttachmentScannerConfig(env: NodeJS.ProcessEnv): AttachmentScannerConfig {
  const mode = (env.ATTACHMENT_SCAN_MODE ?? "none").trim().toLowerCase();
  if (mode === "command") {
    const command = (env.ATTACHMENT_SCAN_COMMAND ?? "").trim();
    if (!command) {
      throw new Error("ATTACHMENT_SCAN_MODE=command requires ATTACHMENT_SCAN_COMMAND");
    }
    const timeoutRaw = Number.parseInt(env.ATTACHMENT_SCAN_TIMEOUT_MS ?? "10000", 10);
    const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 10000;
    return {
      mode: "command",
      command,
      timeoutMs
    };
  }
  return { mode: "none" };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export function createAttachmentScanner(config: AttachmentScannerConfig): AttachmentScanner {
  if (config.mode === "command") {
    return {
      async scan(input: AttachmentUploadInput): Promise<AttachmentScanResult> {
        const scanDir = await mkdtemp(join(tmpdir(), "bridge-scan-"));
        const scanFile = join(scanDir, safeFilename(input.originalName));
        try {
          await writeFile(scanFile, input.bytes);
          const command = config.command.replaceAll("{file}", shellQuote(scanFile));
          await execFileAsync("bash", ["-lc", command], { timeout: config.timeoutMs });
          return { ok: true, detail: "scan passed" };
        } catch (error) {
          const message = error instanceof Error ? error.message : "scanner command failed";
          return { ok: false, detail: message };
        } finally {
          await rm(scanDir, { recursive: true, force: true });
        }
      }
    };
  }

  return {
    async scan(): Promise<AttachmentScanResult> {
      return { ok: true, detail: "scan disabled" };
    }
  };
}

export function createAttachmentStorage(
  config: AttachmentStorageConfig,
  deps: AttachmentStorageDependencies = {}
): AttachmentStorage {
  if (config.driver === "s3") {
    const client = new S3Client({
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey
      }
    });
    return {
      async upload(input) {
        const storageKey = `${config.keyPrefix}/${randomUUID()}-${safeFilename(input.originalName)}`;
        await client.send(
          new PutObjectCommand({
            Bucket: config.bucket,
            Key: storageKey,
            Body: input.bytes,
            ContentType: input.mimeType
          })
        );
        return { storageKey, sizeBytes: input.bytes.length };
      },
      async removeByKey(storageKey) {
        await client.send(
          new DeleteObjectCommand({
            Bucket: config.bucket,
            Key: storageKey
          })
        );
      },
      async readByKey(storageKey) {
        const output = await client.send(
          new GetObjectCommand({
            Bucket: config.bucket,
            Key: storageKey
          })
        );
        const body = output.Body;
        if (!body) {
          throw new Error("missing attachment object body");
        }
        let stream: Readable;
        if (body instanceof Readable) {
          stream = body;
        } else {
          const asBytes = await body.transformToByteArray();
          stream = Readable.from(Buffer.from(asBytes));
        }
        return {
          stream,
          sizeBytes: output.ContentLength ? Number(output.ContentLength) : undefined,
          mimeType: output.ContentType
        };
      }
    };
  }
  if (config.driver === "webdav") {
    return createWebDavAttachmentStorage(config, deps.fetch);
  }

  return {
    async upload(input) {
      await mkdir(config.rootDir, { recursive: true });
      const storageKey = `${randomUUID()}-${safeFilename(input.originalName)}`;
      const destination = join(config.rootDir, storageKey);
      await writeFile(destination, input.bytes);
      return { storageKey, sizeBytes: input.bytes.length };
    },
    async removeByKey(storageKey) {
      const destination = join(config.rootDir, basename(storageKey));
      await rm(destination, { force: true });
    },
    async readByKey(storageKey) {
      const destination = join(config.rootDir, basename(storageKey));
      const buffer = await readFile(destination);
      let sizeBytes: number | undefined;
      try {
        sizeBytes = (await stat(destination)).size;
      } catch {
        sizeBytes = buffer.length;
      }
      return { stream: Readable.from(buffer), sizeBytes };
    }
  };
}

function normalizePathPrefix(raw: string): string {
  return raw
    .split("/")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .join("/");
}

function splitPathSegments(value: string): string[] {
  return value
    .split("/")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function encodePathSegments(segments: string[]): string {
  return segments.map((segment) => encodeURIComponent(segment)).join("/");
}

function normalizeBaseUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);
  if (!url.pathname.endsWith("/")) {
    url.pathname = `${url.pathname}/`;
  }
  url.search = "";
  url.hash = "";
  return url;
}

function validateWebDavBaseUrl(baseUrlRaw: string, allowInsecure: boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrlRaw);
  } catch {
    throw new Error("ATTACHMENT_WEBDAV_BASE_URL must be a valid URL");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("ATTACHMENT_WEBDAV_BASE_URL must not include query parameters or fragments");
  }
  if (parsed.username || parsed.password) {
    throw new Error("ATTACHMENT_WEBDAV_BASE_URL must not include embedded credentials");
  }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== "https:") {
    const isLocalhost = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname.toLowerCase());
    if (!allowInsecure || !isLocalhost || protocol !== "http:") {
      throw new Error(
        "ATTACHMENT_WEBDAV_BASE_URL must use https (set ATTACHMENT_WEBDAV_ALLOW_INSECURE=true only for local http://localhost testing)"
      );
    }
  }
  return parsed.toString();
}

function validateWebDavPathPrefix(pathPrefix: string): void {
  const segments = splitPathSegments(pathPrefix);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("ATTACHMENT_WEBDAV_PATH_PREFIX must not contain '.' or '..' segments");
  }
}

function buildWebDavUrl(baseUrl: string, ...segments: string[]): URL {
  const normalizedBase = normalizeBaseUrl(baseUrl);
  const path = encodePathSegments(segments.flatMap((segment) => splitPathSegments(segment)));
  return new URL(path.length > 0 ? path : ".", normalizedBase);
}

function webdavAuthHeader(username: string, appPassword: string): string {
  return `Basic ${Buffer.from(`${username}:${appPassword}`, "utf8").toString("base64")}`;
}

async function expectWebDavStatus(
  response: Response,
  allowedStatuses: number[],
  context: string
): Promise<Response> {
  if (allowedStatuses.includes(response.status)) {
    return response;
  }
  const body = await response.text().catch(() => "");
  const suffix = body.trim().length > 0 ? `: ${body.trim()}` : "";
  throw new Error(`${context} failed with HTTP ${response.status}${suffix}`);
}

function createWebDavAttachmentStorage(
  config: WebDavStorageConfig,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)
): AttachmentStorage {
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is required for WebDAV attachment storage");
  }
  const authHeader = webdavAuthHeader(config.username, config.appPassword);

  async function ensureCollections(): Promise<void> {
    const segments = splitPathSegments(config.pathPrefix);
    if (segments.length === 0) {
      return;
    }
    const created: string[] = [];
    for (const segment of segments) {
      created.push(segment);
      const collectionUrl = buildWebDavUrl(config.baseUrl, created.join("/"));
      const response = await fetchImpl(collectionUrl, {
        method: "MKCOL",
        headers: {
          Authorization: authHeader
        }
      });
      await expectWebDavStatus(response, [200, 201, 204, 405, 409], "WebDAV MKCOL");
    }
  }

  function buildStorageUrl(storageKey: string): URL {
    return buildWebDavUrl(config.baseUrl, storageKey);
  }

  return {
    async upload(input) {
      const storageSuffix = `${randomUUID()}-${safeFilename(input.originalName)}`;
      const storageKey = normalizePathPrefix([config.pathPrefix, storageSuffix].filter(Boolean).join("/"));
      await ensureCollections();
      const response = await fetchImpl(buildStorageUrl(storageKey), {
        method: "PUT",
        headers: {
          Authorization: authHeader,
          "Content-Type": input.mimeType
        },
        body: new Uint8Array(input.bytes)
      });
      await expectWebDavStatus(response, [200, 201, 204], "WebDAV PUT");
      return { storageKey, sizeBytes: input.bytes.length };
    },
    async removeByKey(storageKey) {
      const response = await fetchImpl(buildStorageUrl(storageKey), {
        method: "DELETE",
        headers: {
          Authorization: authHeader
        }
      });
      await expectWebDavStatus(response, [200, 202, 204, 404], "WebDAV DELETE");
    },
    async readByKey(storageKey) {
      const response = await fetchImpl(buildStorageUrl(storageKey), {
        method: "GET",
        headers: {
          Authorization: authHeader
        }
      });
      await expectWebDavStatus(response, [200], "WebDAV GET");
      const contentType = response.headers.get("content-type") ?? undefined;
      const contentLength = response.headers.get("content-length");
      const buffer = Buffer.from(await response.arrayBuffer());
      return {
        stream: Readable.from(buffer),
        sizeBytes: contentLength ? Number.parseInt(contentLength, 10) : buffer.length,
        mimeType: contentType
      };
    }
  };
}

export function safeFilename(value: string): string {
  const fallback = "file";
  const trimmed = value.trim();
  const base = basename(trimmed.length > 0 ? trimmed : fallback);
  return base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || fallback;
}

export function fileExtension(value: string): string {
  return extname(value).replace(/^\./, "").toLowerCase();
}

export async function readStreamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
