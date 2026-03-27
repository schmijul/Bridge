import Fastify from "fastify";
import cors from "@fastify/cors";
import { WebSocketServer, type WebSocket } from "ws";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ClientEvent, ServerEvent } from "@bridge/shared";
import {
  addMessage,
  channels,
  currentSequence,
  getOnlineUserIds,
  messages,
  typingChanged,
  setPresence,
  setReadState,
  users
} from "./store.js";

const envSchema = z.object({
  PORT: z.coerce.number().default(4000),
  CORS_ORIGIN: z.string().default("http://localhost:5173")
});

const clientEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message:send"),
    payload: z.object({
      channelId: z.string().min(1),
      content: z.string().min(1).max(4000),
      tempId: z.string().min(1)
    })
  }),
  z.object({
    type: z.literal("presence:update"),
    payload: z.object({
      state: z.enum(["online", "away", "offline"])
    })
  }),
  z.object({
    type: z.literal("typing:update"),
    payload: z.object({
      channelId: z.string().min(1),
      isTyping: z.boolean()
    })
  }),
  z.object({
    type: z.literal("read:update"),
    payload: z.object({
      channelId: z.string().min(1),
      lastMessageId: z.string().min(1)
    })
  })
]);

const env = envSchema.parse(process.env);

const app = Fastify({ logger: { level: "info" } });
await app.register(cors, { origin: env.CORS_ORIGIN });

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
    cursor: { sequence: currentSequence() }
  };
});

const server = await app.listen({ port: env.PORT, host: "0.0.0.0" });
const wss = new WebSocketServer({ server: app.server });

const sockets = new Set<WebSocket>();

function broadcast(event: ServerEvent): void {
  const encoded = JSON.stringify(event);
  for (const socket of sockets) {
    if (socket.readyState === socket.OPEN) {
      socket.send(encoded);
    }
  }
}

wss.on("connection", (socket) => {
  sockets.add(socket);

  socket.send(
    JSON.stringify({
      type: "sync:snapshot",
      payload: {
        messages,
        onlineUserIds: getOnlineUserIds(),
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
        const channelExists = channels.some((channel) => channel.id === event.payload.channelId);
        if (!channelExists) {
          socket.send(
            JSON.stringify({
              type: "error",
              payload: { message: "channel not found" }
            } satisfies ServerEvent)
          );
          return;
        }
        const serverEvent = addMessage(
          event.payload.channelId,
          "u-1",
          content
        );
        broadcast(serverEvent);
      }

      if (event.type === "presence:update") {
        broadcast(setPresence("u-1", event.payload.state));
      }

      if (event.type === "typing:update") {
        const channelExists = channels.some((channel) => channel.id === event.payload.channelId);
        if (!channelExists) {
          socket.send(
            JSON.stringify({
              type: "error",
              payload: { message: "channel not found" }
            } satisfies ServerEvent)
          );
          return;
        }
        broadcast(typingChanged("u-1", event.payload.channelId, event.payload.isTyping));
      }

      if (event.type === "read:update") {
        const channelExists = channels.some((channel) => channel.id === event.payload.channelId);
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
        broadcast(
          setReadState("u-1", event.payload.channelId, event.payload.lastMessageId)
        );
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
    broadcast(setPresence("u-1", "offline"));
  });
});

app.log.info(`Bridge API listening on ${server}`);
