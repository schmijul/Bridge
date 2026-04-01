import { randomUUID } from "node:crypto";
import { createClient as createRedisClient } from "redis";
import type { ServerEvent } from "@bridge/shared";

type RealtimeListener = (event: ServerEvent) => void;

export type RealtimeStatus = {
  configured: boolean;
  ok: boolean;
  detail: string;
};

type RedisLikeClient = {
  isReady: boolean;
  isOpen: boolean;
  connect: () => Promise<unknown>;
  publish: (channel: string, message: string) => Promise<number>;
  subscribe: (channel: string, listener: (message: string) => void) => Promise<unknown>;
  quit: () => Promise<unknown>;
  disconnect?: () => Promise<unknown> | void;
  on: (event: "ready" | "end" | "error" | "reconnecting", listener: (...args: unknown[]) => void) => void;
};

type RedisClientFactory = (options: {
  url: string;
  socket: {
    reconnectStrategy: (retries: number) => number;
  };
}) => RedisLikeClient;

export type RealtimeCoordinator = {
  publish: (event: ServerEvent) => void;
  subscribe: (listener: RealtimeListener) => () => void;
  status: () => RealtimeStatus;
  close: () => Promise<void>;
};

export type RealtimeDependencies = {
  createClient?: RedisClientFactory;
  instanceId?: string;
  channel?: string;
  reconnectDelayMs?: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "unknown error";
}

function defaultRedisClientFactory(options: Parameters<RedisClientFactory>[0]): RedisLikeClient {
  return createRedisClient(options) as unknown as RedisLikeClient;
}

export function createLocalRealtimeCoordinator(): RealtimeCoordinator {
  const listeners = new Set<RealtimeListener>();
  const status: RealtimeStatus = { configured: false, ok: false, detail: "not configured" };

  return {
    publish(event) {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch {
          // realtime listeners should not break the bus
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    status() {
      return { ...status };
    },
    async close() {
      listeners.clear();
    }
  };
}

export function createBrokenRedisRealtimeCoordinator(detail: string): RealtimeCoordinator {
  const local = createLocalRealtimeCoordinator();
  return {
    publish: local.publish,
    subscribe: local.subscribe,
    async close() {
      await local.close();
    },
    status() {
      return { configured: true, ok: false, detail };
    }
  };
}

export async function createRealtimeCoordinator(
  redisUrl: string | undefined,
  deps: RealtimeDependencies = {}
): Promise<RealtimeCoordinator> {
  if (!redisUrl) {
    return createLocalRealtimeCoordinator();
  }

  try {
    const parsed = new URL(redisUrl);
    if (!["redis:", "rediss:"].includes(parsed.protocol)) {
      return createBrokenRedisRealtimeCoordinator(`unsupported REDIS_URL protocol: ${parsed.protocol}`);
    }
  } catch {
    return createBrokenRedisRealtimeCoordinator("invalid REDIS_URL");
  }

  const listeners = new Set<RealtimeListener>();
  const status: RealtimeStatus = { configured: true, ok: false, detail: "connecting" };
  const instanceId = deps.instanceId ?? randomUUID();
  const channel = deps.channel ?? "bridge:realtime:v1";
  const reconnectDelayMs = deps.reconnectDelayMs ?? 1000;
  const createClient = deps.createClient ?? defaultRedisClientFactory;

  let disposed = false;
  let publisher: RedisLikeClient | null = null;
  let subscriber: RedisLikeClient | null = null;
  let subscriptionReady = false;

  function refreshStatus(detail?: string): void {
    if (detail) {
      status.detail = detail;
    }
    const publisherReady = publisher?.isReady ?? false;
    const subscriberReady = subscriber?.isReady ?? false;
    status.ok = publisherReady && subscriberReady && subscriptionReady;
    if (status.ok) {
      status.detail = "connected";
      return;
    }
    if (!status.detail || status.detail === "connected") {
      status.detail = "connecting";
    }
  }

  function emit(event: ServerEvent): void {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // realtime listeners should not break the bus
      }
    }
  }

  function handleRedisMessage(message: string): void {
    try {
      const parsed = JSON.parse(message) as { originId?: string; event?: ServerEvent };
      if (!parsed || typeof parsed !== "object") {
        return;
      }
      if (parsed.originId === instanceId) {
        return;
      }
      if (!parsed.event || typeof parsed.event !== "object") {
        return;
      }
      emit(parsed.event);
    } catch {
      // ignore malformed pub/sub payloads
    }
  }

  publisher = createClient({
    url: redisUrl,
    socket: {
      reconnectStrategy: (retries) => Math.min(1000, Math.max(reconnectDelayMs, retries * 100))
    }
  });
  subscriber = createClient({
    url: redisUrl,
    socket: {
      reconnectStrategy: (retries) => Math.min(1000, Math.max(reconnectDelayMs, retries * 100))
    }
  });

  publisher.on("ready", () => {
    refreshStatus();
  });
  publisher.on("reconnecting", () => {
    refreshStatus("reconnecting");
  });
  publisher.on("end", () => {
    refreshStatus("disconnected");
  });
  publisher.on("error", (error) => {
    refreshStatus(`publisher error: ${errorMessage(error)}`);
  });

  subscriber.on("ready", async () => {
    if (disposed || subscriptionReady) {
      refreshStatus();
      return;
    }
    try {
      await subscriber?.subscribe(channel, handleRedisMessage);
      subscriptionReady = true;
      refreshStatus();
    } catch (error) {
      refreshStatus(`subscriber subscribe failed: ${errorMessage(error)}`);
    }
  });
  subscriber.on("reconnecting", () => {
    refreshStatus("reconnecting");
  });
  subscriber.on("end", () => {
    refreshStatus("disconnected");
  });
  subscriber.on("error", (error) => {
    refreshStatus(`subscriber error: ${errorMessage(error)}`);
  });

  void publisher.connect().catch((error) => {
    refreshStatus(`publisher connect failed: ${errorMessage(error)}`);
  });
  void subscriber.connect().catch((error) => {
    refreshStatus(`subscriber connect failed: ${errorMessage(error)}`);
  });

  return {
    publish(event) {
      emit(event);
      if (!status.configured || !publisher?.isReady) {
        return;
      }
      void publisher
        .publish(channel, JSON.stringify({ originId: instanceId, event }))
        .catch((error) => {
          refreshStatus(`publisher publish failed: ${errorMessage(error)}`);
        });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    status() {
      return { ...status };
    },
    async close() {
      disposed = true;
      listeners.clear();
      const tasks: Promise<unknown>[] = [];
      if (publisher) {
        tasks.push(
          Promise.resolve(publisher.disconnect ? publisher.disconnect() : publisher.quit()).catch(() => undefined)
        );
      }
      if (subscriber) {
        tasks.push(
          Promise.resolve(subscriber.disconnect ? subscriber.disconnect() : subscriber.quit()).catch(
            () => undefined
          )
        );
      }
      await Promise.all(tasks);
    }
  };
}
