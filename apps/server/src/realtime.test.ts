import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import test from "node:test";
import type { ServerEvent } from "@bridge/shared";
import { createLocalRealtimeCoordinator, createRealtimeCoordinator } from "./realtime.js";

type FakeRedisBus = {
  subscribe: (channel: string, listener: (message: string) => void) => () => void;
  publish: (channel: string, message: string) => number;
};

function createFakeRedisBus(): FakeRedisBus {
  const channels = new Map<string, Set<(message: string) => void>>();
  return {
    subscribe(channel, listener) {
      const listeners = channels.get(channel) ?? new Set<(message: string) => void>();
      listeners.add(listener);
      channels.set(channel, listeners);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          channels.delete(channel);
        }
      };
    },
    publish(channel, message) {
      const listeners = channels.get(channel);
      if (!listeners) {
        return 0;
      }
      for (const listener of listeners) {
        listener(message);
      }
      return listeners.size;
    }
  };
}

function createFakeRedisClientFactory(bus: FakeRedisBus) {
  return () => {
    const emitter = new EventEmitter();
    const unsubscribers: Array<() => void> = [];
    const client = {
      isReady: false,
      isOpen: false,
      on(event: "ready" | "end" | "error" | "reconnecting", listener: (...args: unknown[]) => void) {
        emitter.on(event, listener);
      },
      async connect() {
        client.isOpen = true;
        queueMicrotask(() => {
          client.isReady = true;
          emitter.emit("ready");
        });
      },
      async publish(channel: string, message: string) {
        return bus.publish(channel, message);
      },
      async subscribe(channel: string, listener: (message: string) => void) {
        unsubscribers.push(bus.subscribe(channel, listener));
      },
      async quit() {
        client.isReady = false;
        client.isOpen = false;
        while (unsubscribers.length > 0) {
          unsubscribers.pop()?.();
        }
        emitter.emit("end");
      }
    };
    return client;
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("local realtime coordinator delivers events without Redis", async () => {
  const coordinator = createLocalRealtimeCoordinator();
  const seen: ServerEvent[] = [];
  const unsubscribe = coordinator.subscribe((event) => {
    seen.push(event);
  });

  const event: ServerEvent = {
    type: "typing:changed",
    payload: { userId: "u-1", channelId: "c-1", isTyping: true, sequence: 1 }
  };

  coordinator.publish(event);

  assert.deepEqual(seen, [event]);
  assert.deepEqual(coordinator.status(), {
    configured: false,
    ok: false,
    detail: "not configured"
  });

  unsubscribe();
  await coordinator.close();
});

test("Redis-backed realtime coordinator fans out events across instances", async () => {
  const bus = createFakeRedisBus();
  const createClient = createFakeRedisClientFactory(bus);

  const coordinatorA = await createRealtimeCoordinator("redis://localhost:6379", {
    createClient,
    instanceId: "instance-a",
    channel: "bridge:test:realtime",
    reconnectDelayMs: 1
  });
  const coordinatorB = await createRealtimeCoordinator("redis://localhost:6379", {
    createClient,
    instanceId: "instance-b",
    channel: "bridge:test:realtime",
    reconnectDelayMs: 1
  });

  await waitFor(() => coordinatorA.status().ok && coordinatorB.status().ok);

  const seenA: ServerEvent[] = [];
  const seenB: ServerEvent[] = [];
  coordinatorA.subscribe((event) => {
    seenA.push(event);
  });
  coordinatorB.subscribe((event) => {
    seenB.push(event);
  });

  const event: ServerEvent = {
    type: "presence:changed",
    payload: { userId: "u-1", state: "online", sequence: 42 }
  };

  coordinatorA.publish(event);

  await waitFor(() => seenA.length === 1 && seenB.length === 1);
  assert.deepEqual(seenA, [event]);
  assert.deepEqual(seenB, [event]);
  assert.equal(coordinatorA.status().configured, true);
  assert.equal(coordinatorA.status().ok, true);

  await coordinatorA.close();
  await coordinatorB.close();
});
