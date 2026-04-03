import {
  claimNotificationDeliveries,
  getNotificationDeliveryStats,
  markNotificationDeliveryDelivered,
  markNotificationDeliveryFailed,
  type NotificationRecord
} from "./store.js";

export type PushDeliveryConfig = {
  enabled: boolean;
  provider: "webhook";
  webhookUrl?: string;
  webhookAuthHeader?: string;
  pollIntervalMs: number;
  batchSize: number;
  maxAttempts: number;
  retryBaseMs: number;
  retryMaxMs: number;
};

export type PushDeliveryRunResult = {
  claimed: number;
  delivered: number;
  retried: number;
  failedTerminal: number;
  errors: number;
  skippedRead: number;
};

export type PushDeliveryRunner = {
  runOnce: () => Promise<PushDeliveryRunResult>;
  start: () => void;
  stop: () => void;
  getStatus: () => {
    enabled: boolean;
    running: boolean;
    polling: boolean;
    stats: ReturnType<typeof getNotificationDeliveryStats>;
  };
};

type PushDeliveryDependencies = {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  onResult?: (result: PushDeliveryRunResult) => void;
};

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

export function parsePushDeliveryConfig(env: NodeJS.ProcessEnv): PushDeliveryConfig {
  const enabled = envBoolean("PUSH_DELIVERY_ENABLED", false);
  const provider = (env.PUSH_DELIVERY_PROVIDER ?? "webhook").trim().toLowerCase();
  if (provider !== "webhook") {
    throw new Error("PUSH_DELIVERY_PROVIDER must be 'webhook'");
  }

  const config: PushDeliveryConfig = {
    enabled,
    provider: "webhook",
    webhookUrl: env.PUSH_DELIVERY_WEBHOOK_URL,
    webhookAuthHeader: env.PUSH_DELIVERY_WEBHOOK_AUTH_HEADER,
    pollIntervalMs: envNumber("PUSH_DELIVERY_POLL_INTERVAL_MS", 3_000),
    batchSize: envNumber("PUSH_DELIVERY_BATCH_SIZE", 20),
    maxAttempts: envNumber("PUSH_DELIVERY_MAX_ATTEMPTS", 5),
    retryBaseMs: envNumber("PUSH_DELIVERY_RETRY_BASE_MS", 5_000),
    retryMaxMs: envNumber("PUSH_DELIVERY_RETRY_MAX_MS", 5 * 60_000)
  };

  if (enabled && !config.webhookUrl) {
    throw new Error("PUSH_DELIVERY_ENABLED=true requires PUSH_DELIVERY_WEBHOOK_URL");
  }

  return config;
}

async function deliverWebhook(
  fetchImpl: typeof fetch,
  config: PushDeliveryConfig,
  notification: NotificationRecord
): Promise<void> {
  if (!config.webhookUrl) {
    throw new Error("missing webhook URL");
  }
  const headers: Record<string, string> = {
    "content-type": "application/json"
  };
  if (config.webhookAuthHeader) {
    headers.authorization = config.webhookAuthHeader;
  }

  const response = await fetchImpl(config.webhookUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      notificationId: notification.id,
      userId: notification.userId,
      type: notification.type,
      actorId: notification.actorId,
      channelId: notification.channelId,
      messageId: notification.messageId,
      createdAt: notification.createdAt
    })
  });

  if (response.status < 200 || response.status >= 300) {
    const body = await response.text().catch(() => "");
    const suffix = body.trim().length > 0 ? `: ${body.trim()}` : "";
    throw new Error(`webhook responded with HTTP ${response.status}${suffix}`);
  }
}

export function createPushDeliveryRunner(
  config: PushDeliveryConfig,
  deps: PushDeliveryDependencies = {}
): PushDeliveryRunner {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  if (config.enabled && typeof fetchImpl !== "function") {
    throw new Error("fetch is required when PUSH_DELIVERY_ENABLED=true");
  }

  let timer: NodeJS.Timeout | null = null;
  let running = false;

  async function runOnce(): Promise<PushDeliveryRunResult> {
    if (!config.enabled) {
      return {
        claimed: 0,
        delivered: 0,
        retried: 0,
        failedTerminal: 0,
        errors: 0,
        skippedRead: 0
      };
    }
    const nowIso = (deps.now?.() ?? new Date()).toISOString();
    const jobs = claimNotificationDeliveries(config.batchSize, nowIso);
    const result: PushDeliveryRunResult = {
      claimed: jobs.length,
      delivered: 0,
      retried: 0,
      failedTerminal: 0,
      errors: 0,
      skippedRead: 0
    };

    for (const job of jobs) {
      if (job.notification.readAt) {
        markNotificationDeliveryDelivered(job.delivery.id, nowIso);
        result.delivered += 1;
        result.skippedRead += 1;
        continue;
      }
      try {
        await deliverWebhook(fetchImpl as typeof fetch, config, job.notification);
        markNotificationDeliveryDelivered(job.delivery.id, nowIso);
        result.delivered += 1;
      } catch (error) {
        const willBeTerminal = job.delivery.attemptCount + 1 >= config.maxAttempts;
        markNotificationDeliveryFailed(job.delivery.id, error instanceof Error ? error.message : "push delivery failed", {
          maxAttempts: config.maxAttempts,
          retryBaseMs: config.retryBaseMs,
          retryMaxMs: config.retryMaxMs,
          nowIso
        });
        result.errors += 1;
        if (willBeTerminal) {
          result.failedTerminal += 1;
        } else {
          result.retried += 1;
        }
      }
    }

    deps.onResult?.(result);
    return result;
  }

  function start(): void {
    if (!config.enabled || timer) {
      return;
    }
    timer = setInterval(() => {
      if (running) {
        return;
      }
      running = true;
      runOnce()
        .catch((error) => {
          console.error("push delivery run error", error);
        })
        .finally(() => {
          running = false;
        });
    }, Math.max(500, config.pollIntervalMs));
    timer.unref?.();
  }

  function stop(): void {
    if (!timer) {
      return;
    }
    clearInterval(timer);
    timer = null;
  }

  return {
    runOnce,
    start,
    stop,
    getStatus: () => ({
      enabled: config.enabled,
      running,
      polling: timer !== null,
      stats: getNotificationDeliveryStats()
    })
  };
}
