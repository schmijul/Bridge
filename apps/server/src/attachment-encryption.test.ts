import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import test from "node:test";
import type { AttachmentStorage } from "./attachments.js";
import { readStreamToBuffer } from "./attachments.js";
import {
  createEncryptedAttachmentStorage,
  decodeAttachmentEnvelope,
  parseAttachmentEncryptionKey
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

test("attachment encryption roundtrips plaintext and preserves mime type", async () => {
  const base = createMemoryStorage();
  const key = Buffer.alloc(32, 7);
  const storage = createEncryptedAttachmentStorage(base, { key });

  const plaintext = Buffer.from("hello encrypted attachments");
  const upload = await storage.upload({
    bytes: plaintext,
    mimeType: "text/plain",
    originalName: "note.txt"
  });
  const raw = base.getRaw(upload.storageKey);
  assert.ok(raw);
  assert.notEqual(raw!.toString("utf8").includes("hello encrypted attachments"), true);

  const download = await storage.readByKey(upload.storageKey);
  assert.equal(download.mimeType, "text/plain");
  assert.equal((await readStreamToBuffer(download.stream)).toString("utf8"), plaintext.toString("utf8"));
});

test("attachment encryption fails with the wrong key", async () => {
  const base = createMemoryStorage();
  const key = Buffer.alloc(32, 9);
  const storage = createEncryptedAttachmentStorage(base, { key });
  const upload = await storage.upload({
    bytes: Buffer.from("secret payload"),
    mimeType: "text/plain",
    originalName: "secret.txt"
  });

  const wrongKeyStorage = createEncryptedAttachmentStorage(base, { key: Buffer.alloc(32, 11) });
  await assert.rejects(() => wrongKeyStorage.readByKey(upload.storageKey));
});

test("envelope parsing rejects unsupported versions and parses configured keys", () => {
  const hexKey = parseAttachmentEncryptionKey("01".repeat(32));
  assert.equal(hexKey?.length, 32);

  const base64Key = parseAttachmentEncryptionKey(Buffer.alloc(32, 4).toString("base64"));
  assert.equal(base64Key?.length, 32);

  assert.throws(
    () =>
      decodeAttachmentEnvelope(
        Buffer.from(
          JSON.stringify({
            version: 2,
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
});
