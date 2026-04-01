import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import type {
  AttachmentStorage,
  AttachmentUploadInput,
  StoredAttachment
} from "./attachments.js";
import { readStreamToBuffer } from "./attachments.js";

const ENVELOPE_VERSION = 1 as const;
const ENVELOPE_AAD = Buffer.from("bridge:attachment-envelope:v1", "utf8");

export type AttachmentEncryptionConfig = {
  key: Buffer;
};

export type AttachmentEnvelopeV1 = {
  version: 1;
  algorithm: "aes-256-gcm";
  encoding: "base64";
  iv: string;
  authTag: string;
  ciphertext: string;
  mimeType: string;
};

export type ParsedAttachmentEnvelope = {
  envelope: AttachmentEnvelopeV1;
  plaintext: Buffer;
};

export function parseAttachmentEncryptionKey(raw: string | undefined): Buffer | null {
  if (!raw || raw.trim().length === 0) {
    return null;
  }
  const value = raw.trim();
  const hexValue = value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value;
  if (/^[0-9a-fA-F]{64}$/.test(hexValue)) {
    const key = Buffer.from(hexValue, "hex");
    if (key.length === 32) {
      return key;
    }
  }

  if (/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    const key = Buffer.from(value, "base64");
    if (key.length === 32) {
      return key;
    }
  }

  throw new Error("ATTACHMENT_ENCRYPTION_KEY must be a 32-byte key encoded as hex or base64");
}

export function parseAttachmentEncryptionConfig(
  env: NodeJS.ProcessEnv
): AttachmentEncryptionConfig | null {
  const key = parseAttachmentEncryptionKey(env.ATTACHMENT_ENCRYPTION_KEY);
  return key ? { key } : null;
}

export function encryptAttachmentPayload(input: AttachmentUploadInput, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(ENVELOPE_AAD);
  const ciphertext = Buffer.concat([cipher.update(input.bytes), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const envelope: AttachmentEnvelopeV1 = {
    version: ENVELOPE_VERSION,
    algorithm: "aes-256-gcm",
    encoding: "base64",
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    mimeType: input.mimeType
  };
  return Buffer.from(JSON.stringify(envelope), "utf8");
}

export function decodeAttachmentEnvelope(raw: Buffer): AttachmentEnvelopeV1 {
  const parsed = JSON.parse(raw.toString("utf8")) as Partial<AttachmentEnvelopeV1> & {
    version?: number;
    algorithm?: string;
    encoding?: string;
    iv?: string;
    authTag?: string;
    ciphertext?: string;
    mimeType?: string;
  };
  if (parsed.version !== 1) {
    throw new Error(`unsupported attachment envelope version: ${String(parsed.version)}`);
  }
  if (parsed.algorithm !== "aes-256-gcm") {
    throw new Error(`unsupported attachment envelope algorithm: ${String(parsed.algorithm)}`);
  }
  if (parsed.encoding !== "base64") {
    throw new Error(`unsupported attachment envelope encoding: ${String(parsed.encoding)}`);
  }
  if (!parsed.iv || !parsed.authTag || !parsed.ciphertext || !parsed.mimeType) {
    throw new Error("attachment envelope is missing required fields");
  }
  return {
    version: 1,
    algorithm: "aes-256-gcm",
    encoding: "base64",
    iv: parsed.iv,
    authTag: parsed.authTag,
    ciphertext: parsed.ciphertext,
    mimeType: parsed.mimeType
  };
}

export function decryptAttachmentPayload(raw: Buffer, key: Buffer): ParsedAttachmentEnvelope {
  const envelope = decodeAttachmentEnvelope(raw);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(envelope.iv, "base64")
  );
  decipher.setAAD(ENVELOPE_AAD);
  decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final()
  ]);
  return { envelope, plaintext };
}

export function createEncryptedAttachmentStorage(
  storage: AttachmentStorage,
  config: AttachmentEncryptionConfig
): AttachmentStorage {
  return {
    async upload(input: AttachmentUploadInput): Promise<StoredAttachment> {
      const encryptedBytes = encryptAttachmentPayload(input, config.key);
      const stored = await storage.upload({
        bytes: encryptedBytes,
        mimeType: "application/json",
        originalName: input.originalName
      });
      return { storageKey: stored.storageKey, sizeBytes: input.bytes.length };
    },
    async removeByKey(storageKey: string): Promise<void> {
      await storage.removeByKey(storageKey);
    },
    async readByKey(storageKey: string) {
      const stored = await storage.readByKey(storageKey);
      const raw = await readStreamToBuffer(stored.stream);
      const decrypted = decryptAttachmentPayload(raw, config.key);
      return {
        stream: Readable.from(decrypted.plaintext),
        sizeBytes: decrypted.plaintext.length,
        mimeType: decrypted.envelope.mimeType
      };
    }
  };
}
