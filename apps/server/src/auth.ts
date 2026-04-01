import { createHash, randomBytes, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import type { User } from "@bridge/shared";
import { getDbPool } from "./db.js";

const persistenceEnabled = process.env.STORE_DRIVER === "postgres" && Boolean(process.env.DATABASE_URL);
const sessionTtlMs = 1000 * 60 * 60 * 24 * 7;

const passwordByUserId = new Map<string, string>();
const sessionById = new Map<string, { userId: string; expiresAt: string }>();
const botTokenByHash = new Map<string, string>();

const devDefaultPasswords: Record<string, string> = {
  "u-1": "bridge123!",
  "u-2": "bridge123!",
  "u-3": "bridge123!",
  "u-4": "bridge123!"
};

async function persistSession(
  sessionId: string,
  userId: string,
  expiresAt: string
): Promise<void> {
  if (!persistenceEnabled) {
    return;
  }
  const db = getDbPool();
  await db.query(
    `INSERT INTO sessions (id, user_id, expires_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id, expires_at = EXCLUDED.expires_at`,
    [sessionId, userId, expiresAt]
  );
}

export async function initAuth(users: User[]): Promise<void> {
  if (persistenceEnabled) {
    const db = getDbPool();
    for (const user of users) {
      const defaultPassword = devDefaultPasswords[user.id];
      if (!defaultPassword) {
        continue;
      }
      const hash = await bcrypt.hash(defaultPassword, 10);
      await db.query(
        `INSERT INTO user_credentials (user_id, password_hash)
         VALUES ($1, $2)
         ON CONFLICT (user_id) DO NOTHING`,
        [user.id, hash]
      );
    }

    const credentials = await db.query<{ user_id: string; password_hash: string }>(
      "SELECT user_id, password_hash FROM user_credentials"
    );
    passwordByUserId.clear();
    for (const row of credentials.rows) {
      passwordByUserId.set(row.user_id, row.password_hash);
    }
    for (const user of users) {
      if (user.isBot) {
        passwordByUserId.delete(user.id);
      }
    }

    const sessions = await db.query<{ id: string; user_id: string; expires_at: Date | string }>(
      "SELECT id, user_id, expires_at FROM sessions WHERE expires_at > NOW()"
    );
    sessionById.clear();
    for (const row of sessions.rows) {
      sessionById.set(row.id, {
        userId: row.user_id,
        expiresAt: new Date(row.expires_at).toISOString()
      });
    }

    const botTokens = await db.query<{
      bot_user_id: string;
      token_hash: string;
      revoked_at: Date | string | null;
    }>("SELECT bot_user_id, token_hash, revoked_at FROM bot_api_tokens");
    botTokenByHash.clear();
    for (const row of botTokens.rows) {
      if (row.revoked_at) {
        continue;
      }
      botTokenByHash.set(row.token_hash, row.bot_user_id);
    }
    return;
  }

  passwordByUserId.clear();
  sessionById.clear();
  botTokenByHash.clear();
  for (const user of users) {
    if (user.isBot) {
      continue;
    }
    const password = devDefaultPasswords[user.id] ?? "welcome123";
    passwordByUserId.set(user.id, await bcrypt.hash(password, 10));
  }
}

export async function verifyPassword(userId: string, password: string): Promise<boolean> {
  const hash = passwordByUserId.get(userId);
  if (!hash) {
    return false;
  }
  return bcrypt.compare(password, hash);
}

export async function setPassword(userId: string, password: string): Promise<void> {
  const hash = await bcrypt.hash(password, 10);
  passwordByUserId.set(userId, hash);
  if (!persistenceEnabled) {
    return;
  }
  const db = getDbPool();
  await db.query(
    `INSERT INTO user_credentials (user_id, password_hash)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = NOW()`,
    [userId, hash]
  );
}

function hashBotToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export async function createBotToken(botUserId: string): Promise<string> {
  const rawToken = randomBytes(32).toString("base64url");
  const tokenHash = hashBotToken(rawToken);
  if (!persistenceEnabled) {
    botTokenByHash.set(tokenHash, botUserId);
    return rawToken;
  }

  const db = getDbPool();
  await db.query(
    `INSERT INTO bot_api_tokens (id, bot_user_id, token_hash, created_at)
     VALUES ($1, $2, $3, NOW())`,
    [randomUUID(), botUserId, tokenHash]
  );
  botTokenByHash.set(tokenHash, botUserId);
  return rawToken;
}

export async function getUserIdFromBotToken(token: string | undefined): Promise<string | null> {
  if (!token) {
    return null;
  }
  const botUserId = botTokenByHash.get(hashBotToken(token));
  return botUserId ?? null;
}

export async function createSession(userId: string): Promise<{ sessionId: string; expiresAt: string }> {
  const sessionId = randomUUID();
  const expiresAt = new Date(Date.now() + sessionTtlMs).toISOString();
  sessionById.set(sessionId, { userId, expiresAt });
  await persistSession(sessionId, userId, expiresAt);
  return { sessionId, expiresAt };
}

export async function getUserIdFromSession(sessionId: string | undefined): Promise<string | null> {
  if (!sessionId) {
    return null;
  }

  const session = sessionById.get(sessionId);
  if (session) {
    if (new Date(session.expiresAt).getTime() <= Date.now()) {
      await deleteSession(sessionId);
      return null;
    }
    return session.userId;
  }

  if (!persistenceEnabled) {
    return null;
  }

  const db = getDbPool();
  const result = await db.query<{ user_id: string; expires_at: Date | string }>(
    "SELECT user_id, expires_at FROM sessions WHERE id = $1",
    [sessionId]
  );
  if ((result.rowCount ?? 0) === 0) {
    return null;
  }

  const row = result.rows[0];
  const expiresAt = new Date(row.expires_at).toISOString();
  if (new Date(expiresAt).getTime() <= Date.now()) {
    await deleteSession(sessionId);
    return null;
  }

  sessionById.set(sessionId, { userId: row.user_id, expiresAt });
  return row.user_id;
}

export async function deleteSession(sessionId: string | undefined): Promise<void> {
  if (!sessionId) {
    return;
  }
  sessionById.delete(sessionId);
  if (!persistenceEnabled) {
    return;
  }
  const db = getDbPool();
  await db.query("DELETE FROM sessions WHERE id = $1", [sessionId]);
}

export async function deleteSessionsForUser(userId: string): Promise<void> {
  for (const [sessionId, session] of sessionById.entries()) {
    if (session.userId === userId) {
      sessionById.delete(sessionId);
    }
  }
  if (!persistenceEnabled) {
    return;
  }
  const db = getDbPool();
  await db.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
}
