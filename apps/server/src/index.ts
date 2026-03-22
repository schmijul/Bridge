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
      const event = JSON.parse(buffer.toString("utf8")) as ClientEvent;
      if (event.type === "message:send") {
        const serverEvent = addMessage(
          event.payload.channelId,
          "u-1",
          event.payload.content.trim()
        );
        broadcast(serverEvent);
      }

      if (event.type === "presence:update") {
        broadcast(setPresence("u-1", event.payload.state));
      }

      if (event.type === "typing:update") {
        broadcast(typingChanged("u-1", event.payload.channelId, event.payload.isTyping));
      }

      if (event.type === "read:update") {
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
