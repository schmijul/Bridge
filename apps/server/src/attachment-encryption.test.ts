import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import test from "node:test";
import type { AttachmentStorage } from "./attachments.js";
import { readStreamToBuffer } from "./attachments.js";
import {
  createEncryptedAttachmentStorage,
  decodeAttachmentEnvelope,
  parseAttachmentEncryptionConfig
} from "./attachment-encryption.js";

function createMemoryStorage(): AttachmentStorage & { getRaw: (key: string) => Buffer | undefined } {
  const store = new Map<string, { bytes: Buffer; mimeType?: string }>();
  return {
    getRaw(key: string) {
      return store.get(key)?.bytes;
    },
    async upload(input) {
      const storageKey = randomUUID();
      store.set(storageKey, { bytes: Buffer.from(input.bytes), mimeType: input.mimeType });
      return { storageKey, sizeBytes: input.bytes.length };
    },
    async removeByKey(storageKey) {
      store.delete(storageKey);
    },
    async readByKey(storageKey) {
      const entry = store.get(storageKey);
      if (!entry) {
        throw new Error("missing key");
      }
      return {
        stream: Readable.from(entry.bytes),
        sizeBytes: entry.bytes.length,
        mimeType: entry.mimeType
      };
    }
  };
}

function keyEntry(keyId: string, fill: number) {
  return {
    keyId,
    key: Buffer.alloc(32, fill)
  };
}

test("attachment encryption roundtrips with the primary key", async () => {
  const base = createMemoryStorage();
  const storage = createEncryptedAttachmentStorage(base, {
    primaryKey: keyEntry("2026-04", 7),
    fallbackKeys: []
  });

  const plaintext = Buffer.from("hello encrypted attachments");
  const upload = await storage.upload({
    bytes: plaintext,
    mimeType: "text/plain",
    originalName: "note.txt"
  });
  const raw = base.getRaw(upload.storageKey);
  assert.ok(raw);
  assert.equal(raw!.toString("utf8").includes(plaintext.toString("utf8")), false);

  const envelope = decodeAttachmentEnvelope(raw!);
  assert.equal(envelope.version, 2);
  assert.equal(envelope.keyId, "2026-04");

  const download = await storage.readByKey(upload.storageKey);
  assert.equal(download.mimeType, "text/plain");
  assert.equal((await readStreamToBuffer(download.stream)).toString("utf8"), plaintext.toString("utf8"));
});

test("attachment encryption decrypts legacy payloads with a fallback key", async () => {
  const base = createMemoryStorage();
  const oldStorage = createEncryptedAttachmentStorage(base, {
    primaryKey: keyEntry("2026-03", 9),
    fallbackKeys: []
  });
  const upload = await oldStorage.upload({
    bytes: Buffer.from("legacy payload"),
    mimeType: "text/plain",
    originalName: "legacy.txt"
  });

  const rotatedStorage = createEncryptedAttachmentStorage(base, {
    primaryKey: keyEntry("2026-04", 7),
    fallbackKeys: [keyEntry("2026-03", 9)]
  });
  const download = await rotatedStorage.readByKey(upload.storageKey);
  assert.equal((await readStreamToBuffer(download.stream)).toString("utf8"), "legacy payload");

  const raw = base.getRaw(upload.storageKey);
  assert.ok(raw);
  const envelope = decodeAttachmentEnvelope(raw!);
  assert.equal(envelope.version, 2);
  assert.equal(envelope.keyId, "2026-03");
});

test("attachment encryption fails when no configured key can decrypt", async () => {
  const base = createMemoryStorage();
  const oldStorage = createEncryptedAttachmentStorage(base, {
    primaryKey: keyEntry("2026-03", 9),
    fallbackKeys: []
  });
  const upload = await oldStorage.upload({
    bytes: Buffer.from("secret payload"),
    mimeType: "text/plain",
    originalName: "secret.txt"
  });

  const wrongStorage = createEncryptedAttachmentStorage(base, {
    primaryKey: keyEntry("2026-04", 7),
    fallbackKeys: [keyEntry("2026-02", 8)]
  });
  await assert.rejects(() => wrongStorage.readByKey(upload.storageKey), /unable to decrypt attachment/i);
});

test("envelope parsing preserves versioned metadata and env config accepts rotation keys", () => {
  const envelope = decodeAttachmentEnvelope(
    Buffer.from(
      JSON.stringify({
        version: 2,
        algorithm: "aes-256-gcm",
        encoding: "base64",
        keyId: "2026-04",
        iv: "abc",
        authTag: "def",
        ciphertext: "ghi",
        mimeType: "text/plain"
      })
    )
  );
  assert.equal(envelope.version, 2);
  assert.equal(envelope.keyId, "2026-04");

  assert.throws(
    () =>
      decodeAttachmentEnvelope(
        Buffer.from(
          JSON.stringify({
            version: 99,
            algorithm: "aes-256-gcm",
            encoding: "base64",
            iv: "abc",
            authTag: "def",
            ciphertext: "ghi",
            mimeType: "text/plain"
          })
        )
      ),
    /unsupported attachment envelope version/i
  );

  const legacy = parseAttachmentEncryptionConfig({
    ATTACHMENT_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("hex")
  } as NodeJS.ProcessEnv);
  assert.equal(legacy?.primaryKey.keyId, "primary");
  assert.equal(legacy?.fallbackKeys.length, 0);

  const rotated = parseAttachmentEncryptionConfig({
    ATTACHMENT_ENCRYPTION_PRIMARY_KEY: Buffer.alloc(32, 5).toString("base64"),
    ATTACHMENT_ENCRYPTION_PRIMARY_KEY_ID: "2026-04",
    ATTACHMENT_ENCRYPTION_FALLBACK_KEYS: `2026-03=${Buffer.alloc(32, 6).toString("hex")}`
  } as NodeJS.ProcessEnv);
  assert.equal(rotated?.primaryKey.keyId, "2026-04");
  assert.equal(rotated?.fallbackKeys[0]?.keyId, "2026-03");
});
