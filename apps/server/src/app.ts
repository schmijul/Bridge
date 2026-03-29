import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import { WebSocketServer, type WebSocket } from "ws";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ClientEvent, ServerEvent } from "@bridge/shared";
import {
  addMessage,
  appendAuditLog,
  archiveChannel,
  channels,
  createChannel,
  currentSequence,
  deleteMessage,
  getAdminOverview,
  getOnlineUserIds,
  getUserByEmail,
  getUserById,
  inviteUser,
  messages,
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
  getUserIdFromSession,
  setPassword,
  verifyPassword
} from "./auth.js";

const messageSendSchema = z.object({
  type: z.literal("message:send"),
  payload: z.object({
    channelId: z.string().min(1),
    content: z.string().min(1).max(4000),
    tempId: z.string().min(1)
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

async function resolveActorId(
  request: FastifyRequest,
  fallbackToHeader: boolean
): Promise<string | null> {
  const sessionId = sessionIdFromCookie(request.headers.cookie);
  const userIdFromSession = await getUserIdFromSession(sessionId);
  if (userIdFromSession) {
    return userIdFromSession;
  }

  if (!fallbackToHeader) {
    return null;
  }

  const raw = request.headers["x-user-id"];
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw.trim();
  }
  return "u-1";
}

async function requireAdmin(
  request: FastifyRequest
): Promise<{ ok: true; actorId: string } | { ok: false; reason: string }> {
  const actorId = await resolveActorId(request, true);
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
  const actorId = await resolveActorId(request, true);
  if (!actorId) {
    return { ok: false, reason: "unauthorized" };
  }
  const actor = getUserById(actorId);
  if (!actor || !actor.isActive) {
    return { ok: false, reason: "unauthorized" };
  }
  return { ok: true, actorId };
}

export async function createBridgeApp(corsOrigin: string): Promise<{
  app: FastifyInstance;
  attachRealtime: () => void;
}> {
  const app = Fastify({ logger: { level: "info" } });
  await app.register(cors, { origin: corsOrigin });
  await app.register(cookie);

  const sockets = new Set<WebSocket>();

  function broadcast(event: ServerEvent): void {
    const encoded = JSON.stringify(event);
    for (const socket of sockets) {
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

  app.get("/bootstrap", async () => {
    return {
      users,
      channels,
      messages,
      onlineUserIds: getOnlineUserIds(),
      workspace,
      cursor: { sequence: currentSequence() }
    };
  });

  app.post("/auth/login", async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ message: "invalid login payload" });
    }

    const user = getUserByEmail(parsed.data.email);
    if (!user || !user.isActive) {
      return reply.code(401).send({ message: "invalid credentials" });
    }

    const ok = await verifyPassword(user.id, parsed.data.password);
    if (!ok) {
      return reply.code(401).send({ message: "invalid credentials" });
    }

    const { sessionId, expiresAt } = await createSession(user.id);
    reply.setCookie("bridge_session", sessionId, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: false,
      expires: new Date(expiresAt)
    });

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
    const actorId = await resolveActorId(request, true);
    if (!actorId) {
      return reply.code(401).send({ message: "unauthorized" });
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
    const sessionId = sessionIdFromCookie(request.headers.cookie);
    await deleteSession(sessionId);
    reply.clearCookie("bridge_session", { path: "/" });
    return { ok: true };
  });

  app.get("/admin/overview", async (request, reply) => {
    const auth = await requireAdmin(request);
    if (!auth.ok) {
      return reply.code(403).send({ message: auth.reason });
    }
    return getAdminOverview();
  });

  app.post("/admin/channels", async (request, reply) => {
    const auth = await requireAdmin(request);
    if (!auth.ok) {
      return reply.code(403).send({ message: auth.reason });
    }

    const parsed = createChannelSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ message: "invalid channel payload" });
    }

    if (channels.some((channel) => channel.name === parsed.data.name && !channel.archivedAt)) {
      return reply.code(409).send({ message: "channel name already exists" });
    }

    const channelEvent = createChannel(parsed.data);
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

  app.post("/admin/users", async (request, reply) => {
    const auth = await requireAdmin(request);
    if (!auth.ok) {
      return reply.code(403).send({ message: auth.reason });
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
      sockets.add(socket);
      const requestLike = { headers: request.headers } as FastifyRequest;
      const actorId = (await resolveActorId(requestLike, true)) ?? "u-1";

      socket.send(
        JSON.stringify({
          type: "sync:snapshot",
          payload: {
            users,
            channels,
            messages,
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

            const serverEvent = addMessage(event.payload.channelId, actorId, content);
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
        broadcast(setPresence(actorId, "offline"));
      });
    });
  };

  return { app, attachRealtime };
}
