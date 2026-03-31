import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { Readable } from "node:stream";
import { GetObjectCommand, PutObjectCommand, DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";

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

export type AttachmentStorageConfig = LocalStorageConfig | S3StorageConfig;

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
  return {
    driver: "local",
    rootDir: env.ATTACHMENT_LOCAL_DIR ?? join(process.cwd(), ".bridge_uploads")
  };
}

export function createAttachmentStorage(config: AttachmentStorageConfig): AttachmentStorage {
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
