import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import { WebSocketServer, type WebSocket } from "ws";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ClientEvent, ServerEvent } from "@bridge/shared";
import { getDbPool } from "./db.js";
import {
  addMessage,
  appendAuditLog,
  archiveChannel,
  addChannelMember,
  channels,
  createChannel,
  createDirectConversation,
  currentSequence,
  deleteMessage,
  getChannelMemberIds,
  getChannelsForUser,
  getDirectConversationsForUser,
  getAdminOverview,
  getMessagesForUser,
  getUnreadCountsForUser,
  isPersistenceEnabled,
  nextSequence,
  getOnlineUserIds,
  getUserByEmail,
  getUserById,
  inviteUser,
  isUserAllowedInChannel,
  messages,
  removeChannelMember,
  setPresence,
  setReadState,
  setUserActive,
  typingChanged,
  updateUserRole,
  updateWorkspaceSettings,
  users,
  workspace
} from "./store.js";
import {
  createSession,
  deleteSession,
  deleteSessionsForUser,
  getUserIdFromSession,
  setPassword,
  verifyPassword
} from "./auth.js";

const messageSendSchema = z.object({
  type: z.literal("message:send"),
  payload: z.object({
    channelId: z.string().min(1),
    content: z.string().min(1).max(4000),
    tempId: z.string().min(1),
    threadRootMessageId: z.string().min(1).optional()
  })
});

const presenceSchema = z.object({
  type: z.literal("presence:update"),
  payload: z.object({
    state: z.enum(["online", "away", "offline"])
  })
});

const typingSchema = z.object({
  type: z.literal("typing:update"),
  payload: z.object({
    channelId: z.string().min(1),
    isTyping: z.boolean()
  })
});

const readSchema = z.object({
  type: z.literal("read:update"),
  payload: z.object({
    channelId: z.string().min(1),
    lastMessageId: z.string().min(1)
  })
});

const clientEventSchema = z.discriminatedUnion("type", [
  messageSendSchema,
  presenceSchema,
  typingSchema,
  readSchema
]);

const createChannelSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9-]+$/, "channel name must match [a-z0-9-]"),
  description: z.string().trim().min(4).max(180),
  isPrivate: z.boolean().default(false)
});

const archiveChannelSchema = z.object({
  archived: z.literal(true)
});

const channelMemberSchema = z.object({
  userId: z.string().trim().min(1)
});

const inviteUserSchema = z.object({
  displayName: z.string().trim().min(2).max(60),
  email: z.string().trim().email(),
  role: z.enum(["admin", "manager", "member", "guest"])
});

const updateUserRoleSchema = z.object({
  role: z.enum(["admin", "manager", "member", "guest"])
});

const updateUserStatusSchema = z.object({
  isActive: z.boolean()
});

const updateWorkspaceSchema = z.object({
  workspaceName: z.string().trim().min(3).max(80).optional(),
  messageRetentionDays: z.number().int().min(7).max(3650).optional(),
  allowGuestAccess: z.boolean().optional(),
  enforceMfaForAdmins: z.boolean().optional()
});

const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(8).max(256)
});

const createConversationSchema = z.object({
  participantUserIds: z.array(z.string().trim().min(1)).min(1).max(11)
});

type RateLimitDecision = {
  allowed: boolean;
  retryAfterSeconds: number;
};

type AuthMode = "local" | "oidc";

type OidcRoleGroups = {
  admin: Set<string>;
  manager: Set<string>;
  member: Set<string>;
  guest: Set<string>;
};

function createFixedWindowRateLimiter(maxHits: number, windowMs: number): {
  consume: (key: string) => RateLimitDecision;
  inspect: (key: string) => RateLimitDecision;
  reset: (key: string) => void;
} {
  const buckets = new Map<string, { count: number; windowStartMs: number }>();
  function inspect(key: string): RateLimitDecision {
    const now = Date.now();
    const current = buckets.get(key);
    if (!current || now - current.windowStartMs >= windowMs) {
      return { allowed: true, retryAfterSeconds: 0 };
    }
    if (current.count >= maxHits) {
      const retryAfterMs = Math.max(0, windowMs - (now - current.windowStartMs));
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }
  return {
    inspect,
    consume(key: string): RateLimitDecision {
      const state = inspect(key);
      if (!state.allowed) {
        return state;
      }
      const now = Date.now();
      const current = buckets.get(key);
      if (!current || now - current.windowStartMs >= windowMs) {
        buckets.set(key, { count: 1, windowStartMs: now });
        return { allowed: true, retryAfterSeconds: 0 };
      }
      current.count += 1;
      buckets.set(key, current);
      return { allowed: true, retryAfterSeconds: 0 };
    },
    reset(key: string): void {
      buckets.delete(key);
    }
  };
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function normalizeSameSite(raw: string | undefined): "lax" | "strict" | "none" {
  const normalized = (raw ?? "").trim().toLowerCase();
  if (normalized === "strict" || normalized === "none") {
    return normalized;
  }
  return "lax";
}

function parseCorsOrigins(corsOrigin: string): string[] {
  return corsOrigin
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function normalizeAuthMode(raw: string | undefined): AuthMode {
  const normalized = (raw ?? "").trim().toLowerCase();
  return normalized === "oidc" ? "oidc" : "local";
}

function parseGroupSet(raw: string | undefined): Set<string> {
  if (!raw) {
    return new Set<string>();
  }
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0)
  );
}

function parseGroupsHeader(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

function resolveOidcRole(groups: string[], roleGroups: OidcRoleGroups): "admin" | "manager" | "member" | "guest" {
  const groupSet = new Set(groups);
  if ([...roleGroups.admin].some((group) => groupSet.has(group))) {
    return "admin";
  }
  if ([...roleGroups.manager].some((group) => groupSet.has(group))) {
    return "manager";
  }
  if ([...roleGroups.member].some((group) => groupSet.has(group))) {
    return "member";
  }
  if ([...roleGroups.guest].some((group) => groupSet.has(group))) {
    return "guest";
  }
  return "member";
}

function escapeCsv(value: string): string {
  const escaped = value.replaceAll("\"", "\"\"");
  return `"${escaped}"`;
}

function getClientAddress(request: FastifyRequest, trustProxyHeaders: boolean): string {
  if (trustProxyHeaders) {
    const forwarded = request.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.trim().length > 0) {
      return forwarded.split(",")[0]!.trim();
    }
  }
  return request.ip;
}

function getSecurityHeaderValue(enabled: boolean): string | undefined {
  return enabled ? "max-age=31536000; includeSubDomains" : undefined;
}

function sessionCookieConfig(
  secure: boolean,
  sameSite: "lax" | "strict" | "none",
  domain: string | undefined,
  expiresAt: string
): {
  httpOnly: true;
  sameSite: "lax" | "strict" | "none";
  path: "/";
  secure: boolean;
  expires: Date;
  domain?: string;
} {
  return {
    httpOnly: true,
    sameSite,
    path: "/",
    secure,
    expires: new Date(expiresAt),
    ...(domain ? { domain } : {})
  };
}

function clearSessionCookieConfig(
  secure: boolean,
  sameSite: "lax" | "strict" | "none",
  domain: string | undefined
): {
  path: "/";
  secure: boolean;
  sameSite: "lax" | "strict" | "none";
  domain?: string;
} {
  return {
    path: "/",
    secure,
    sameSite,
    ...(domain ? { domain } : {})
  };
}

function sessionIdFromCookie(cookieHeader: unknown): string | undefined {
  if (typeof cookieHeader !== "string") {
    return undefined;
  }
  const rawCookie = cookieHeader
    .split(";")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith("bridge_session="));
  if (!rawCookie) {
    return undefined;
  }
  const value = rawCookie.slice("bridge_session=".length);
  return value.length > 0 ? value : undefined;
}

function extractMentionUserIds(content: string): string[] {
  const handles = [...content.matchAll(/@([a-z0-9_.-]{2,32})/gi)].map((match) => match[1].toLowerCase());
  if (handles.length === 0) {
    return [];
  }
  const result = new Set<string>();
  for (const user of users) {
    const handleCandidates = [
      user.displayName.toLowerCase().replace(/\s+/g, ""),
      user.email.split("@")[0]?.toLowerCase() ?? ""
    ];
    if (handleCandidates.some((candidate) => handles.includes(candidate))) {
      result.add(user.id);
    }
  }
  return [...result];
}

async function resolveActorId(request: FastifyRequest): Promise<string | null> {
  const sessionId = sessionIdFromCookie(request.headers.cookie);
  const userIdFromSession = await getUserIdFromSession(sessionId);
  if (userIdFromSession) {
    return userIdFromSession;
  }
  return null;
}

async function requireAdmin(
  request: FastifyRequest
): Promise<{ ok: true; actorId: string } | { ok: false; reason: string }> {
  const actorId = await resolveActorId(request);
  if (!actorId) {
    return { ok: false, reason: "unauthorized" };
  }
  const actor = getUserById(actorId);
  if (!actor) {
    return { ok: false, reason: "unknown actor" };
  }
  if (actor.role !== "admin" && actor.role !== "manager") {
    return { ok: false, reason: "admin role required" };
  }
  return { ok: true, actorId };
}

async function requireAuthenticated(
  request: FastifyRequest
): Promise<{ ok: true; actorId: string } | { ok: false; reason: string }> {
  const actorId = await resolveActorId(request);
  if (!actorId) {
    return { ok: false, reason: "unauthorized" };
  }
  const actor = getUserById(actorId);
  if (!actor || !actor.isActive) {
    return { ok: false, reason: "unauthorized" };
  }
  return { ok: true, actorId };
}

export async function createBridgeApp(
  corsOrigin: string,
  options?: {
    rateLimit?: {
      authLoginMax?: number;
      authLoginWindowMs?: number;
      authFailureMax?: number;
      authFailureWindowMs?: number;
      apiMax?: number;
      apiWindowMs?: number;
    };
    security?: {
      trustProxyHeaders?: boolean;
      sessionCookieSecure?: boolean;
      sessionCookieSameSite?: "lax" | "strict" | "none";
      sessionCookieDomain?: string;
    };
    auth?: {
      mode?: AuthMode;
      oidcEmailHeader?: string;
      oidcDisplayNameHeader?: string;
      oidcGroupsHeader?: string;
      roleGroups?: {
        admin?: string;
        manager?: string;
        member?: string;
        guest?: string;
      };
    };
  }
): Promise<{
  app: FastifyInstance;
  attachRealtime: () => void;
}> {
  const trustProxyHeaders =
    options?.security?.trustProxyHeaders ?? envBoolean("TRUST_PROXY_HEADERS", false);
  const sessionCookieSecure =
    options?.security?.sessionCookieSecure ?? envBoolean("SESSION_COOKIE_SECURE", false);
  const sessionCookieSameSite =
    options?.security?.sessionCookieSameSite ??
    normalizeSameSite(process.env.SESSION_COOKIE_SAMESITE);
  const sessionCookieDomain =
    options?.security?.sessionCookieDomain ?? process.env.SESSION_COOKIE_DOMAIN;
  const authMode = options?.auth?.mode ?? normalizeAuthMode(process.env.AUTH_MODE);
  const oidcEmailHeader = (options?.auth?.oidcEmailHeader ?? process.env.OIDC_EMAIL_HEADER ?? "x-auth-request-email")
    .toLowerCase()
    .trim();
  const oidcDisplayNameHeader = (
    options?.auth?.oidcDisplayNameHeader ??
    process.env.OIDC_DISPLAY_NAME_HEADER ??
    "x-auth-request-name"
  )
    .toLowerCase()
    .trim();
  const oidcGroupsHeader = (
    options?.auth?.oidcGroupsHeader ??
    process.env.OIDC_GROUPS_HEADER ??
    "x-auth-request-groups"
  )
    .toLowerCase()
    .trim();
  const oidcRoleGroups: OidcRoleGroups = {
    admin: parseGroupSet(options?.auth?.roleGroups?.admin ?? process.env.OIDC_ROLE_GROUP_ADMIN),
    manager: parseGroupSet(options?.auth?.roleGroups?.manager ?? process.env.OIDC_ROLE_GROUP_MANAGER),
    member: parseGroupSet(options?.auth?.roleGroups?.member ?? process.env.OIDC_ROLE_GROUP_MEMBER),
    guest: parseGroupSet(options?.auth?.roleGroups?.guest ?? process.env.OIDC_ROLE_GROUP_GUEST)
  };
  const corsAllowList = parseCorsOrigins(corsOrigin);
  const corsOriginMatcher =
    corsAllowList.length <= 1
      ? corsAllowList[0] ?? false
      : (origin: string | undefined, cb: (err: Error | null, allow: boolean) => void) => {
          if (!origin) {
            cb(null, true);
            return;
          }
          cb(null, corsAllowList.includes(origin));
        };

  const app = Fastify({ logger: { level: "info" } });
  await app.register(cors, { origin: corsOriginMatcher, credentials: true });
  await app.register(cookie);
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
    reply.header("content-security-policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    const hsts = getSecurityHeaderValue(sessionCookieSecure);
    if (hsts) {
      reply.header("strict-transport-security", hsts);
    }
    return payload;
  });

  const sockets = new Set<WebSocket>();
  const socketActorId = new Map<WebSocket, string>();
  const loginLimiter = createFixedWindowRateLimiter(
    options?.rateLimit?.authLoginMax ?? envNumber("AUTH_LOGIN_RATE_LIMIT_MAX", 20),
    options?.rateLimit?.authLoginWindowMs ?? envNumber("AUTH_LOGIN_RATE_LIMIT_WINDOW_MS", 5 * 60 * 1000)
  );
  const loginFailureLimiter = createFixedWindowRateLimiter(
    options?.rateLimit?.authFailureMax ?? envNumber("AUTH_LOGIN_FAILURE_LIMIT_MAX", 6),
    options?.rateLimit?.authFailureWindowMs ??
      envNumber("AUTH_LOGIN_FAILURE_LIMIT_WINDOW_MS", 15 * 60 * 1000)
  );
  const apiLimiter = createFixedWindowRateLimiter(
    options?.rateLimit?.apiMax ?? envNumber("API_RATE_LIMIT_MAX", 180),
    options?.rateLimit?.apiWindowMs ?? envNumber("API_RATE_LIMIT_WINDOW_MS", 60 * 1000)
  );

  function rejectRateLimited(reply: FastifyReply, retryAfterSeconds: number): FastifyReply {
    reply.header("retry-after", String(retryAfterSeconds));
    return reply.code(429).send({ message: "rate limit exceeded", retryAfterSeconds });
  }

  function enforceApiRateLimit(
    request: FastifyRequest,
    reply: FastifyReply,
    actorId: string
  ): FastifyReply | null {
    const decision = apiLimiter.consume(`${actorId}|${getClientAddress(request, trustProxyHeaders)}`);
    if (!decision.allowed) {
      return rejectRateLimited(reply, decision.retryAfterSeconds);
    }
    return null;
  }

  function eventChannelId(event: ServerEvent): string | null {
    if (event.type === "message:new") {
      return event.payload.channelId;
    }
    if (event.type === "message:deleted") {
      return event.payload.channelId;
    }
    if (event.type === "typing:changed") {
      return event.payload.channelId;
    }
    if (event.type === "read:changed") {
      return event.payload.channelId;
    }
    if (event.type === "channel:created" || event.type === "channel:updated") {
      return event.payload.id;
    }
    return null;
  }

  function broadcast(event: ServerEvent): void {
    const encoded = JSON.stringify(event);
    for (const socket of sockets) {
      const actorId = socketActorId.get(socket);
      if (!actorId) {
        continue;
      }
      const channelId = eventChannelId(event);
      if (channelId && !isUserAllowedInChannel(actorId, channelId)) {
        continue;
      }
      if (socket.readyState === socket.OPEN) {
        socket.send(encoded);
      }
    }
  }

  app.get("/health", async () => {
    let buildMeta: Record<string, unknown> = { note: "build metadata unavailable" };
    const currentDir = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      resolve(currentDir, "../../../build-meta.json"),
      resolve(process.cwd(), "dist/build-meta.json")
    ];
    try {
      for (const metaPath of candidates) {
        try {
          buildMeta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
          break;
        } catch {
          // try next path candidate
        }
      }
    } catch {
      // This endpoint stays valid in dev before first build.
    }

    return {
      ok: true,
      privacy: {
        analyticsEnabled: false,
        piiLogging: "minimal"
      },
      build: buildMeta
    };
  });

  app.get("/ready", async (_request, reply) => {
    const storeDriver = isPersistenceEnabled() ? "postgres" : "memory";
    let storeStatus: { ok: boolean; detail: string } = { ok: true, detail: "memory store active" };
    if (isPersistenceEnabled()) {
      try {
        await getDbPool().query("SELECT 1");
        storeStatus = { ok: true, detail: "postgres reachable" };
      } catch (error) {
        storeStatus = {
          ok: false,
          detail: `postgres check failed: ${error instanceof Error ? error.message : "unknown error"}`
        };
      }
    }

    const response = {
      ok: storeStatus.ok,
      timestamp: new Date().toISOString(),
      dependencies: {
        store: {
          driver: storeDriver,
          ...storeStatus
        },
        redis: {
          configured: false,
          ok: false,
          detail: "not configured"
        }
      }
    };
    return reply.code(response.ok ? 200 : 503).send(response);
  });

  app.get("/auth/mode", async () => ({ mode: authMode }));

  app.get("/bootstrap", async (request, reply) => {
    const auth = await requireAuthenticated(request);
    if (!auth.ok) {
      return reply.code(401).send({ message: auth.reason });
    }
    const limited = enforceApiRateLimit(request, reply, auth.actorId);
    if (limited) {
      return limited;
    }
    return {
      users,
      channels: getChannelsForUser(auth.actorId),
      messages: getMessagesForUser(auth.actorId),
      onlineUserIds: getOnlineUserIds(),
      workspace,
      cursor: { sequence: currentSequence() }
    };
  });

  app.post("/auth/login", async (request, reply) => {
    if (authMode !== "local") {
      return reply.code(405).send({ message: "password login disabled; use oidc flow" });
    }
    const clientAddress = getClientAddress(request, trustProxyHeaders);
    const loginBurst = loginLimiter.consume(clientAddress);
    if (!loginBurst.allowed) {
      return rejectRateLimited(reply, loginBurst.retryAfterSeconds);
    }

    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ message: "invalid login payload" });
    }

    const authAttemptKey = `${parsed.data.email.toLowerCase()}|${clientAddress}`;
    const failureWindow = loginFailureLimiter.inspect(authAttemptKey);
    if (!failureWindow.allowed) {
      return rejectRateLimited(reply, failureWindow.retryAfterSeconds);
    }

    const user = getUserByEmail(parsed.data.email);
    if (!user || !user.isActive) {
      const failed = loginFailureLimiter.consume(authAttemptKey);
      if (!failed.allowed) {
        return rejectRateLimited(reply, failed.retryAfterSeconds);
      }
      return reply.code(401).send({ message: "invalid credentials" });
    }

    const ok = await verifyPassword(user.id, parsed.data.password);
    if (!ok) {
      const failed = loginFailureLimiter.consume(authAttemptKey);
      if (!failed.allowed) {
        return rejectRateLimited(reply, failed.retryAfterSeconds);
      }
      return reply.code(401).send({ message: "invalid credentials" });
    }
    loginFailureLimiter.reset(authAttemptKey);

    const previousSessionId = sessionIdFromCookie(request.headers.cookie);
    await deleteSession(previousSessionId);
    const { sessionId, expiresAt } = await createSession(user.id);
    reply.setCookie(
      "bridge_session",
      sessionId,
      sessionCookieConfig(sessionCookieSecure, sessionCookieSameSite, sessionCookieDomain, expiresAt)
    );
    broadcast(
      appendAuditLog({
        action: "auth.login",
        actorId: user.id,
        targetType: "user",
        targetId: user.id,
        summary: "Authenticated session login"
      })
    );

    return {
      user: {
        id: user.id,
        displayName: user.displayName,
        email: user.email,
        role: user.role
      }
    };
  });

  app.post("/auth/oidc/login", async (request, reply) => {
    if (authMode !== "oidc") {
      return reply.code(404).send({ message: "oidc auth flow disabled" });
    }

    const clientAddress = getClientAddress(request, trustProxyHeaders);
    const loginBurst = loginLimiter.consume(clientAddress);
    if (!loginBurst.allowed) {
      return rejectRateLimited(reply, loginBurst.retryAfterSeconds);
    }

    const emailHeader = request.headers[oidcEmailHeader];
    const displayNameHeader = request.headers[oidcDisplayNameHeader];
    const groupsHeader = request.headers[oidcGroupsHeader];
    const email = (Array.isArray(emailHeader) ? emailHeader[0] : emailHeader)?.trim().toLowerCase();
    if (!email) {
      return reply.code(401).send({ message: "missing oidc identity headers" });
    }

    const user = getUserByEmail(email);
    if (!user || !user.isActive) {
      return reply.code(403).send({ message: "oidc user is not provisioned or inactive" });
    }

    const groups = parseGroupsHeader(Array.isArray(groupsHeader) ? groupsHeader[0] : groupsHeader);
    const mappedRole = resolveOidcRole(groups, oidcRoleGroups);
    if (user.role !== mappedRole) {
      const roleEvent = updateUserRole(user.id, mappedRole);
      await deleteSessionsForUser(user.id);
      if (roleEvent) {
        broadcast(roleEvent);
      }
      broadcast(
        appendAuditLog({
          action: "auth.oidc.role_synced",
          actorId: user.id,
          targetType: "user",
          targetId: user.id,
          summary: `Synchronized role from OIDC groups to ${mappedRole}`
        })
      );
    }

    const previousSessionId = sessionIdFromCookie(request.headers.cookie);
    await deleteSession(previousSessionId);
    const { sessionId, expiresAt } = await createSession(user.id);
    reply.setCookie(
      "bridge_session",
      sessionId,
      sessionCookieConfig(sessionCookieSecure, sessionCookieSameSite, sessionCookieDomain, expiresAt)
    );

    const resolvedDisplayName = (
      Array.isArray(displayNameHeader) ? displayNameHeader[0] : displayNameHeader
    )?.trim();

    broadcast(
      appendAuditLog({
        action: "auth.oidc.login",
        actorId: user.id,
        targetType: "user",
        targetId: user.id,
        summary: `OIDC login${resolvedDisplayName ? ` as ${resolvedDisplayName}` : ""}`
      })
    );

    return {
      user: {
        id: user.id,
        displayName: user.displayName,
        email: user.email,
        role: user.role
      }
    };
  });

  app.get("/auth/me", async (request, reply) => {
    const actorId = await resolveActorId(request);
    if (!actorId) {
      return reply.code(401).send({ message: "unauthorized" });
    }
    const limited = enforceApiRateLimit(request, reply, actorId);
    if (limited) {
      return limited;
    }
    const user = getUserById(actorId);
    if (!user || !user.isActive) {
      return reply.code(401).send({ message: "unauthorized" });
    }
    return { user };
  });

  app.get("/search/messages", async (request, reply) => {
    const auth = await requireAuthenticated(request);
    if (!auth.ok) {
      return reply.code(401).send({ message: auth.reason });
    }
    const limited = enforceApiRateLimit(request, reply, auth.actorId);
    if (limited) {
      return limited;
    }

    const querySchema = z.object({
      q: z.string().trim().min(2).max(120),
      limit: z.coerce.number().int().min(1).max(100).default(20)
    });
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ message: "invalid search query" });
    }

    const q = parsed.data.q.toLowerCase();
    const results = messages
      .filter((message) => isUserAllowedInChannel(auth.actorId, message.channelId))
      .filter((message) => message.content.toLowerCase().includes(q))
      .slice(-parsed.data.limit)
      .reverse()
      .map((message) => {
        const sender = getUserById(message.senderId);
        const channel = channels.find((entry) => entry.id === message.channelId);
        return {
          ...message,
          senderDisplayName: sender?.displayName ?? message.senderId,
          channelName: channel?.name ?? "unknown"
        };
      });

    return {
      query: parsed.data.q,
      count: results.length,
      results
    };
  });

  app.post("/auth/logout", async (request, reply) => {
    const actorId = await resolveActorId(request);
    if (actorId) {
      const limited = enforceApiRateLimit(request, reply, actorId);
      if (limited) {
        return limited;
      }
    }
    const sessionId = sessionIdFromCookie(request.headers.cookie);
    await deleteSession(sessionId);
    reply.clearCookie(
      "bridge_session",
      clearSessionCookieConfig(sessionCookieSecure, sessionCookieSameSite, sessionCookieDomain)
    );
    if (actorId) {
      broadcast(
        appendAuditLog({
          action: "auth.logout",
          actorId,
          targetType: "user",
          targetId: actorId,
          summary: "Session logout"
        })
      );
    }
    return { ok: true };
  });

  app.get("/dm/conversations", async (request, reply) => {
    const auth = await requireAuthenticated(request);
    if (!auth.ok) {
      return reply.code(401).send({ message: auth.reason });
    }
    const limited = enforceApiRateLimit(request, reply, auth.actorId);
    if (limited) {
      return limited;
    }
    return {
      conversations: getDirectConversationsForUser(auth.actorId)
    };
  });

  app.get("/me/unread", async (request, reply) => {
    const auth = await requireAuthenticated(request);
    if (!auth.ok) {
      return reply.code(401).send({ message: auth.reason });
    }
    const limited = enforceApiRateLimit(request, reply, auth.actorId);
    if (limited) {
      return limited;
    }
    const counts = getUnreadCountsForUser(auth.actorId);
    return {
      totalUnread: counts.reduce((acc, item) => acc + item.unreadCount, 0),
      channels: counts
    };
  });

  app.post("/dm/conversations", async (request, reply) => {
    const auth = await requireAuthenticated(request);
    if (!auth.ok) {
      return reply.code(401).send({ message: auth.reason });
    }
    const limited = enforceApiRateLimit(request, reply, auth.actorId);
    if (limited) {
      return limited;
    }

    const parsed = createConversationSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ message: "invalid conversation payload" });
    }

    const participantIds = Array.from(new Set([...parsed.data.participantUserIds, auth.actorId]));
    if (participantIds.length < 2 || participantIds.length > 12) {
      return reply
        .code(400)
        .send({ message: "conversation must include between 2 and 12 active participants" });
    }

    const inactiveOrMissing = participantIds.find((userId) => {
      const user = getUserById(userId);
      return !user || !user.isActive;
    });
    if (inactiveOrMissing) {
      return reply.code(404).send({ message: `user not found: ${inactiveOrMissing}` });
    }

    const created = createDirectConversation(auth.actorId, participantIds);
    if (created.created) {
      const channelEvent: ServerEvent = {
        type: "channel:created",
        payload: { ...created.channel, sequence: nextSequence() }
      };
      const auditEvent = appendAuditLog({
        action: "conversation.created",
        actorId: auth.actorId,
        targetType: "channel",
        targetId: created.channel.id,
        summary:
          created.channel.kind === "dm"
            ? "Created direct message conversation"
            : "Created group direct message conversation"
      });
      broadcast(channelEvent);
      broadcast(auditEvent);
    }

    return reply.code(created.created ? 201 : 200).send({
      conversation: created.channel,
      participantIds: created.participantIds
    });
  });

  app.get("/admin/overview", async (request, reply) => {
    const auth = await requireAdmin(request);
    if (!auth.ok) {
      return reply.code(403).send({ message: auth.reason });
    }
    const limited = enforceApiRateLimit(request, reply, auth.actorId);
    if (limited) {
      return limited;
    }
    return getAdminOverview();
  });

  app.get("/admin/audit/export", async (request, reply) => {
    const auth = await requireAdmin(request);
    if (!auth.ok) {
      return reply.code(403).send({ message: auth.reason });
    }
    const limited = enforceApiRateLimit(request, reply, auth.actorId);
    if (limited) {
      return limited;
    }

    const parsed = z
      .object({
        format: z.enum(["json", "csv"]).default("json")
      })
      .safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ message: "invalid audit export query" });
    }

    const entries = getAdminOverview().auditLog;
    if (parsed.data.format === "json") {
      return {
        format: "json",
        count: entries.length,
        entries
      };
    }

    const header = "id,action,actorId,targetType,targetId,summary,createdAt";
    const rows = entries.map((entry) =>
      [
        entry.id,
        entry.action,
        entry.actorId,
        entry.targetType,
        entry.targetId,
        entry.summary,
        entry.createdAt
      ]
        .map((value) => escapeCsv(String(value)))
        .join(",")
    );
    const csv = [header, ...rows].join("\n");
    reply.header("content-type", "text/csv; charset=utf-8");
    return reply.send(csv);
  });

  app.post("/admin/channels", async (request, reply) => {
    const auth = await requireAdmin(request);
    if (!auth.ok) {
      return reply.code(403).send({ message: auth.reason });
    }
    const limited = enforceApiRateLimit(request, reply, auth.actorId);
    if (limited) {
      return limited;
    }

    const parsed = createChannelSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ message: "invalid channel payload" });
    }

    if (channels.some((channel) => channel.name === parsed.data.name && !channel.archivedAt)) {
      return reply.code(409).send({ message: "channel name already exists" });
    }

    const channelEvent = createChannel({ ...parsed.data, creatorId: auth.actorId });
    if (channelEvent.type !== "channel:created") {
      return reply.code(500).send({ message: "unexpected channel event type" });
    }
    const auditEvent = appendAuditLog({
      action: "channel.created",
      actorId: auth.actorId,
      targetType: "channel",
      targetId: channelEvent.payload.id,
      summary: `Created channel #${channelEvent.payload.name}`
    });

    broadcast(channelEvent);
    broadcast(auditEvent);

    return reply.code(201).send({ channel: channelEvent.payload });
  });

  app.patch("/admin/channels/:channelId", async (request, reply) => {
    const auth = await requireAdmin(request);
    if (!auth.ok) {
      return reply.code(403).send({ message: auth.reason });
    }
    const limited = enforceApiRateLimit(request, reply, auth.actorId);
    if (limited) {
      return limited;
    }

    const parsed = archiveChannelSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ message: "invalid channel update payload" });
    }

    const channelId = z.string().parse((request.params as { channelId: string }).channelId);
    const channelEvent = archiveChannel(channelId);
    if (!channelEvent) {
      return reply.code(404).send({ message: "channel not found" });
    }
    if (channelEvent.type !== "channel:updated") {
      return reply.code(500).send({ message: "unexpected channel event type" });
    }

    const auditEvent = appendAuditLog({
      action: "channel.archived",
      actorId: auth.actorId,
      targetType: "channel",
      targetId: channelId,
      summary: `Archived channel #${channelEvent.payload.name}`
    });

    broadcast(channelEvent);
    broadcast(auditEvent);

    return { channel: channelEvent.payload };
  });

  app.post("/admin/channels/:channelId/members", async (request, reply) => {
    const auth = await requireAdmin(request);
    if (!auth.ok) {
      return reply.code(403).send({ message: auth.reason });
    }
    const limited = enforceApiRateLimit(request, reply, auth.actorId);
    if (limited) {
      return limited;
    }

    const parsed = channelMemberSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ message: "invalid channel member payload" });
    }

    const channelId = z.string().parse((request.params as { channelId: string }).channelId);
    const targetUser = getUserById(parsed.data.userId);
    if (!targetUser || !targetUser.isActive) {
      return reply.code(404).send({ message: "user not found" });
    }

    const membership = addChannelMember(channelId, parsed.data.userId);
    if (!membership.ok) {
      if (membership.reason === "channel_not_private") {
        return reply.code(400).send({ message: "channel is not private" });
      }
      return reply.code(404).send({ message: "channel not found" });
    }

    if (!membership.alreadyMember) {
      const auditEvent = appendAuditLog({
        action: "channel.member.added",
        actorId: auth.actorId,
        targetType: "channel",
        targetId: channelId,
        summary: `Added ${targetUser.displayName} to channel membership`
      });
      broadcast(auditEvent);
    }

    return reply.code(membership.alreadyMember ? 200 : 201).send({
      channelId,
      members: getChannelMemberIds(channelId)
    });
  });

  app.delete("/admin/channels/:channelId/members/:userId", async (request, reply) => {
    const auth = await requireAdmin(request);
    if (!auth.ok) {
      return reply.code(403).send({ message: auth.reason });
    }
    const limited = enforceApiRateLimit(request, reply, auth.actorId);
    if (limited) {
      return limited;
    }

    const params = z.object({ channelId: z.string().min(1), userId: z.string().min(1) }).parse(
      request.params
    );
    const targetUser = getUserById(params.userId);
    if (!targetUser) {
      return reply.code(404).send({ message: "user not found" });
    }

    const membership = removeChannelMember(params.channelId, params.userId);
    if (!membership.ok) {
      if (membership.reason === "channel_not_private") {
        return reply.code(400).send({ message: "channel is not private" });
      }
      return reply.code(404).send({ message: "channel not found" });
    }

    if (membership.wasMember) {
      const auditEvent = appendAuditLog({
        action: "channel.member.removed",
        actorId: auth.actorId,
        targetType: "channel",
        targetId: params.channelId,
        summary: `Removed ${targetUser.displayName} from channel membership`
      });
      broadcast(auditEvent);
    }

    return { channelId: params.channelId, members: getChannelMemberIds(params.channelId) };
  });

  app.post("/admin/users", async (request, reply) => {
    const auth = await requireAdmin(request);
    if (!auth.ok) {
      return reply.code(403).send({ message: auth.reason });
    }
    const limited = enforceApiRateLimit(request, reply, auth.actorId);
    if (limited) {
      return limited;
    }

    const parsed = inviteUserSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ message: "invalid user payload" });
    }

    if (users.some((user) => user.email.toLowerCase() === parsed.data.email.toLowerCase())) {
      return reply.code(409).send({ message: "email already exists" });
    }

    const userEvent = inviteUser(parsed.data);
    if (userEvent.type !== "user:updated") {
      return reply.code(500).send({ message: "unexpected user event type" });
    }
    await setPassword(userEvent.payload.id, "welcome123");

    const auditEvent = appendAuditLog({
      action: "user.invited",
      actorId: auth.actorId,
      targetType: "user",
      targetId: userEvent.payload.id,
      summary: `Invited ${userEvent.payload.displayName} as ${userEvent.payload.role}`
    });

    broadcast(userEvent);
    broadcast(auditEvent);

    return reply.code(201).send({ user: userEvent.payload });
  });

  app.patch("/admin/users/:userId/role", async (request, reply) => {
    const auth = await requireAdmin(request);
    if (!auth.ok) {
      return reply.code(403).send({ message: auth.reason });
    }
    const limited = enforceApiRateLimit(request, reply, auth.actorId);
    if (limited) {
      return limited;
    }

    const parsed = updateUserRoleSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ message: "invalid user role payload" });
    }

    const userId = z.string().parse((request.params as { userId: string }).userId);
    const userEvent = updateUserRole(userId, parsed.data.role);
    if (!userEvent) {
      return reply.code(404).send({ message: "user not found" });
    }
    if (userEvent.type !== "user:updated") {
      return reply.code(500).send({ message: "unexpected user event type" });
    }
    await deleteSessionsForUser(userId);

    const auditEvent = appendAuditLog({
      action: "user.role.updated",
      actorId: auth.actorId,
      targetType: "user",
      targetId: userId,
      summary: `Set ${userEvent.payload.displayName} role to ${userEvent.payload.role}`
    });

    broadcast(userEvent);
    broadcast(auditEvent);

    return { user: userEvent.payload };
  });

  app.patch("/admin/users/:userId/status", async (request, reply) => {
    const auth = await requireAdmin(request);
    if (!auth.ok) {
      return reply.code(403).send({ message: auth.reason });
    }
    const limited = enforceApiRateLimit(request, reply, auth.actorId);
    if (limited) {
      return limited;
    }

    const parsed = updateUserStatusSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ message: "invalid user status payload" });
    }

    const userId = z.string().parse((request.params as { userId: string }).userId);
    const userEvent = setUserActive(userId, parsed.data.isActive);
    if (!userEvent) {
      return reply.code(404).send({ message: "user not found" });
    }
    if (userEvent.type !== "user:updated") {
      return reply.code(500).send({ message: "unexpected user event type" });
    }
    await deleteSessionsForUser(userId);

    const auditEvent = appendAuditLog({
      action: "user.status.updated",
      actorId: auth.actorId,
      targetType: "user",
      targetId: userId,
      summary: `${parsed.data.isActive ? "Activated" : "Deactivated"} ${userEvent.payload.displayName}`
    });

    broadcast(userEvent);
    broadcast(auditEvent);

    return { user: userEvent.payload };
  });

  app.patch("/admin/settings", async (request, reply) => {
    const auth = await requireAdmin(request);
    if (!auth.ok) {
      return reply.code(403).send({ message: auth.reason });
    }
    const limited = enforceApiRateLimit(request, reply, auth.actorId);
    if (limited) {
      return limited;
    }

    const parsed = updateWorkspaceSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ message: "invalid workspace settings payload" });
    }

    const patch = parsed.data;
    if (Object.keys(patch).length === 0) {
      return reply.code(400).send({ message: "empty settings payload" });
    }

    const workspaceEvent = updateWorkspaceSettings(patch);
    if (workspaceEvent.type !== "workspace:updated") {
      return reply.code(500).send({ message: "unexpected workspace event type" });
    }
    const auditEvent = appendAuditLog({
      action: "workspace.settings.updated",
      actorId: auth.actorId,
      targetType: "workspace",
      targetId: workspaceEvent.payload.id,
      summary: "Updated workspace security or governance settings"
    });

    broadcast(workspaceEvent);
    broadcast(auditEvent);

    return { workspace: workspaceEvent.payload };
  });

  app.delete("/admin/messages/:messageId", async (request, reply) => {
    const auth = await requireAdmin(request);
    if (!auth.ok) {
      return reply.code(403).send({ message: auth.reason });
    }
    const limited = enforceApiRateLimit(request, reply, auth.actorId);
    if (limited) {
      return limited;
    }

    const messageId = z.string().parse((request.params as { messageId: string }).messageId);
    const messageEvent = deleteMessage(messageId);
    if (!messageEvent) {
      return reply.code(404).send({ message: "message not found" });
    }

    const auditEvent = appendAuditLog({
      action: "message.deleted",
      actorId: auth.actorId,
      targetType: "message",
      targetId: messageId,
      summary: "Deleted message via admin moderation"
    });

    broadcast(messageEvent);
    broadcast(auditEvent);

    return { ok: true };
  });

  const attachRealtime = () => {
    const wss = new WebSocketServer({ server: app.server });

    wss.on("connection", async (socket, request) => {
      const requestLike = { headers: request.headers } as FastifyRequest;
      const actorId = await resolveActorId(requestLike);
      if (!actorId) {
        socket.send(
          JSON.stringify({
            type: "error",
            payload: { message: "unauthorized websocket connection" }
          } satisfies ServerEvent)
        );
        socket.close();
        return;
      }

      sockets.add(socket);
      socketActorId.set(socket, actorId);

      socket.send(
        JSON.stringify({
          type: "sync:snapshot",
          payload: {
            users,
            channels: getChannelsForUser(actorId),
            messages: getMessagesForUser(actorId),
            onlineUserIds: getOnlineUserIds(),
            workspace,
            cursor: { sequence: currentSequence() }
          }
        } satisfies ServerEvent)
      );

      socket.on("message", (buffer) => {
        try {
          const candidate = JSON.parse(buffer.toString("utf8")) as unknown;
          const parsed = clientEventSchema.safeParse(candidate);
          if (!parsed.success) {
            socket.send(
              JSON.stringify({
                type: "error",
                payload: { message: "invalid event payload" }
              } satisfies ServerEvent)
            );
            return;
          }

          const event: ClientEvent = parsed.data;
          if (event.type === "message:send") {
            const content = event.payload.content.trim();
            if (!content) {
              socket.send(
                JSON.stringify({
                  type: "error",
                  payload: { message: "message content cannot be empty" }
                } satisfies ServerEvent)
              );
              return;
            }

            const channelExists = channels.some(
              (channel) => channel.id === event.payload.channelId && !channel.archivedAt
            );
            if (!channelExists) {
              socket.send(
                JSON.stringify({
                  type: "error",
                  payload: { message: "channel not found" }
                } satisfies ServerEvent)
              );
              return;
            }
            if (!isUserAllowedInChannel(actorId, event.payload.channelId)) {
              socket.send(
                JSON.stringify({
                  type: "error",
                  payload: { message: "forbidden channel access" }
                } satisfies ServerEvent)
              );
              return;
            }
            if (event.payload.threadRootMessageId) {
              const root = messages.find((message) => message.id === event.payload.threadRootMessageId);
              if (!root || root.channelId !== event.payload.channelId) {
                socket.send(
                  JSON.stringify({
                    type: "error",
                    payload: { message: "thread root message not found in channel" }
                  } satisfies ServerEvent)
                );
                return;
              }
            }

            const serverEvent = addMessage(event.payload.channelId, actorId, content, {
              threadRootMessageId: event.payload.threadRootMessageId,
              mentionUserIds: extractMentionUserIds(content)
            });
            broadcast(serverEvent);
          }

          if (event.type === "presence:update") {
            broadcast(setPresence(actorId, event.payload.state));
          }

          if (event.type === "typing:update") {
            const channelExists = channels.some(
              (channel) => channel.id === event.payload.channelId && !channel.archivedAt
            );
            if (!channelExists) {
              socket.send(
                JSON.stringify({
                  type: "error",
                  payload: { message: "channel not found" }
                } satisfies ServerEvent)
              );
              return;
            }
            if (!isUserAllowedInChannel(actorId, event.payload.channelId)) {
              socket.send(
                JSON.stringify({
                  type: "error",
                  payload: { message: "forbidden channel access" }
                } satisfies ServerEvent)
              );
              return;
            }
            broadcast(typingChanged(actorId, event.payload.channelId, event.payload.isTyping));
          }

          if (event.type === "read:update") {
            const channelExists = channels.some(
              (channel) => channel.id === event.payload.channelId && !channel.archivedAt
            );
            if (!channelExists) {
              socket.send(
                JSON.stringify({
                  type: "error",
                  payload: { message: "channel not found" }
                } satisfies ServerEvent)
              );
              return;
            }
            if (!isUserAllowedInChannel(actorId, event.payload.channelId)) {
              socket.send(
                JSON.stringify({
                  type: "error",
                  payload: { message: "forbidden channel access" }
                } satisfies ServerEvent)
              );
              return;
            }

            const messageExists = messages.some(
              (message) =>
                message.id === event.payload.lastMessageId &&
                message.channelId === event.payload.channelId
            );
            if (!messageExists) {
              socket.send(
                JSON.stringify({
                  type: "error",
                  payload: { message: "message not found in channel" }
                } satisfies ServerEvent)
              );
              return;
            }

            broadcast(setReadState(actorId, event.payload.channelId, event.payload.lastMessageId));
          }
        } catch {
          socket.send(
            JSON.stringify({
              type: "error",
              payload: { message: "invalid event payload" }
            } satisfies ServerEvent)
          );
        }
      });

      socket.on("close", () => {
        sockets.delete(socket);
        socketActorId.delete(socket);
        broadcast(setPresence(actorId, "offline"));
      });
    });
  };

  return { app, attachRealtime };
}
