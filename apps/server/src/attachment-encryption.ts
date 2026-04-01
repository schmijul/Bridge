import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import type {
  AttachmentStorage,
  AttachmentUploadInput,
  StoredAttachment
} from "./attachments.js";
import { readStreamToBuffer } from "./attachments.js";

const ENVELOPE_VERSION_V1 = 1 as const;
const ENVELOPE_VERSION_V2 = 2 as const;
const ENVELOPE_AAD_V1 = Buffer.from("bridge:attachment-envelope:v1", "utf8");
const KEY_ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;

export type AttachmentEncryptionKeyEntry = {
  keyId: string;
  key: Buffer;
};

export type AttachmentEncryptionConfig = {
  primaryKey: AttachmentEncryptionKeyEntry;
  fallbackKeys: AttachmentEncryptionKeyEntry[];
};

type AttachmentEnvelopeBase = {
  algorithm: "aes-256-gcm";
  encoding: "base64";
  iv: string;
  authTag: string;
  ciphertext: string;
  mimeType: string;
};

export type AttachmentEnvelopeV1 = AttachmentEnvelopeBase & {
  version: 1;
};

export type AttachmentEnvelopeV2 = AttachmentEnvelopeBase & {
  version: 2;
  keyId: string;
};

export type AttachmentEnvelope = AttachmentEnvelopeV1 | AttachmentEnvelopeV2;

export type ParsedAttachmentEnvelope = {
  envelope: AttachmentEnvelope;
  plaintext: Buffer;
  keyIdUsed: string;
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

function validateKeyId(raw: string | undefined, context: string): string {
  const keyId = raw?.trim() ?? "";
  if (keyId.length === 0) {
    throw new Error(`${context} must not be empty`);
  }
  if (!KEY_ID_PATTERN.test(keyId)) {
    throw new Error(`${context} must match [A-Za-z0-9_.:-]+`);
  }
  return keyId;
}

function parseKeyEntry(raw: string, context: string): AttachmentEncryptionKeyEntry {
  const value = raw.trim();
  if (value.length === 0) {
    throw new Error(`${context} must not be empty`);
  }
  const separatorIndex = [value.indexOf("="), value.indexOf(":")]
    .filter((index) => index > 0)
    .sort((left, right) => left - right)[0] ?? -1;
  if (separatorIndex <= 0) {
    throw new Error(`${context} must use keyId=key or keyId:key`);
  }
  const keyId = validateKeyId(value.slice(0, separatorIndex), `${context} key id`);
  const key = parseAttachmentEncryptionKey(value.slice(separatorIndex + 1));
  if (!key) {
    throw new Error(`${context} must include a key`);
  }
  return { keyId, key };
}

function parseFallbackKeyEntries(raw: string | undefined): AttachmentEncryptionKeyEntry[] {
  if (!raw || raw.trim().length === 0) {
    return [];
  }
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry, index) => parseKeyEntry(entry, `ATTACHMENT_ENCRYPTION_FALLBACK_KEYS entry ${index + 1}`));
}

function deduplicateKeyEntries(entries: AttachmentEncryptionKeyEntry[]): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.keyId)) {
      throw new Error(`duplicate attachment encryption key id: ${entry.keyId}`);
    }
    seen.add(entry.keyId);
  }
}

export function parseAttachmentEncryptionConfig(
  env: NodeJS.ProcessEnv
): AttachmentEncryptionConfig | null {
  const primaryRaw = env.ATTACHMENT_ENCRYPTION_PRIMARY_KEY ?? env.ATTACHMENT_ENCRYPTION_KEY;
  if (!primaryRaw || primaryRaw.trim().length === 0) {
    return null;
  }

  const primaryKey = parseAttachmentEncryptionKey(primaryRaw);
  if (!primaryKey) {
    throw new Error("ATTACHMENT_ENCRYPTION_PRIMARY_KEY must be a 32-byte key encoded as hex or base64");
  }
  const primaryKeyId = validateKeyId(env.ATTACHMENT_ENCRYPTION_PRIMARY_KEY_ID ?? "primary", "ATTACHMENT_ENCRYPTION_PRIMARY_KEY_ID");
  const fallbackKeys = parseFallbackKeyEntries(env.ATTACHMENT_ENCRYPTION_FALLBACK_KEYS);

  if (fallbackKeys.some((entry) => entry.keyId === primaryKeyId)) {
    throw new Error("primary attachment encryption key id must not also be listed as a fallback");
  }
  deduplicateKeyEntries([ { keyId: primaryKeyId, key: primaryKey }, ...fallbackKeys ]);

  return {
    primaryKey: { keyId: primaryKeyId, key: primaryKey },
    fallbackKeys
  };
}

function attachmentEnvelopeAad(version: 1 | 2, keyId?: string): Buffer {
  if (version === ENVELOPE_VERSION_V1) {
    return ENVELOPE_AAD_V1;
  }
  if (!keyId) {
    throw new Error("attachment envelope version 2 requires a key id");
  }
  return Buffer.from(`bridge:attachment-envelope:v2:${keyId}`, "utf8");
}

export function encryptAttachmentPayload(
  input: AttachmentUploadInput,
  key: Buffer,
  keyId: string
): Buffer {
  const resolvedKeyId = validateKeyId(keyId, "attachment encryption key id");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(attachmentEnvelopeAad(ENVELOPE_VERSION_V2, resolvedKeyId));
  const ciphertext = Buffer.concat([cipher.update(input.bytes), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const envelope: AttachmentEnvelopeV2 = {
    version: ENVELOPE_VERSION_V2,
    algorithm: "aes-256-gcm",
    encoding: "base64",
    keyId: resolvedKeyId,
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    mimeType: input.mimeType
  };
  return Buffer.from(JSON.stringify(envelope), "utf8");
}

export function decodeAttachmentEnvelope(raw: Buffer): AttachmentEnvelope {
  const parsed = JSON.parse(raw.toString("utf8")) as {
    version?: number;
    algorithm?: string;
    encoding?: string;
    iv?: string;
    authTag?: string;
    ciphertext?: string;
    mimeType?: string;
    keyId?: string;
  };
  if (parsed.version !== ENVELOPE_VERSION_V1 && parsed.version !== ENVELOPE_VERSION_V2) {
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
  if (parsed.version === ENVELOPE_VERSION_V2) {
    return {
      version: ENVELOPE_VERSION_V2,
      algorithm: "aes-256-gcm",
      encoding: "base64",
      keyId: validateKeyId(parsed.keyId, "attachment envelope key id"),
      iv: parsed.iv,
      authTag: parsed.authTag,
      ciphertext: parsed.ciphertext,
      mimeType: parsed.mimeType
    };
  }
  return {
    version: ENVELOPE_VERSION_V1,
    algorithm: "aes-256-gcm",
    encoding: "base64",
    iv: parsed.iv,
    authTag: parsed.authTag,
    ciphertext: parsed.ciphertext,
    mimeType: parsed.mimeType
  };
}

function selectAttachmentKeyCandidates(
  envelope: AttachmentEnvelope,
  config: AttachmentEncryptionConfig
): AttachmentEncryptionKeyEntry[] {
  const ring = [config.primaryKey, ...config.fallbackKeys];
  if (envelope.version === ENVELOPE_VERSION_V2) {
    const matching = ring.find((entry) => entry.keyId === envelope.keyId);
    if (matching) {
      return [matching, ...ring.filter((entry) => entry.keyId !== matching.keyId)];
    }
  }
  return ring;
}

function decryptAttachmentEnvelope(key: Buffer, envelope: AttachmentEnvelope): Buffer {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(envelope.iv, "base64")
  );
  decipher.setAAD(attachmentEnvelopeAad(envelope.version, envelope.version === ENVELOPE_VERSION_V2 ? envelope.keyId : undefined));
  decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final()
  ]);
}

export function decryptAttachmentPayload(raw: Buffer, config: AttachmentEncryptionConfig): ParsedAttachmentEnvelope {
  const envelope = decodeAttachmentEnvelope(raw);
  const candidates = selectAttachmentKeyCandidates(envelope, config);
  let lastError: unknown;

  for (const candidate of candidates) {
    try {
      const plaintext = decryptAttachmentEnvelope(candidate.key, envelope);
      return { envelope, plaintext, keyIdUsed: candidate.keyId };
    } catch (error) {
      lastError = error;
    }
  }

  const keyLabel = envelope.version === ENVELOPE_VERSION_V2 ? ` keyId=${envelope.keyId}` : "";
  const reason = lastError instanceof Error ? ` (${lastError.message})` : "";
  throw new Error(`unable to decrypt attachment with configured keys${keyLabel}${reason}`);
}

export function createEncryptedAttachmentStorage(
  storage: AttachmentStorage,
  config: AttachmentEncryptionConfig
): AttachmentStorage {
  return {
    async upload(input: AttachmentUploadInput): Promise<StoredAttachment> {
      const encryptedBytes = encryptAttachmentPayload(input, config.primaryKey.key, config.primaryKey.keyId);
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
      const decrypted = decryptAttachmentPayload(raw, config);
      return {
        stream: Readable.from(decrypted.plaintext),
        sizeBytes: decrypted.plaintext.length,
        mimeType: decrypted.envelope.mimeType
      };
    }
  };
}
