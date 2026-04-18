import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { createBridgeApp } from "./app.js";
import { closeDbPool, runMigrations } from "./db.js";
import { initStore, users } from "./store.js";
import { initAuth, startSessionCleanup, stopSessionCleanup } from "./auth.js";

const envSchema = z.object({
  PORT: z.coerce.number().default(4000),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  AUTH_MODE: z.enum(["local", "oidc"]).default("local"),
  STORE_DRIVER: z.enum(["memory", "postgres"]).default("memory"),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  RUN_MIGRATIONS_ON_BOOT: z
    .string()
    .transform((value) => value.toLowerCase() === "true")
    .default("false")
});

const buildMetaSchema = z.object({
  commitSha: z.string().min(1),
  buildTime: z.string().min(1)
});

const env = envSchema.parse(process.env);

async function loadBuildMetadata(): Promise<{
  commitSha: string;
  buildTime: string;
  analyticsEnabled: boolean;
}> {
  const fallback = {
    commitSha: (process.env.BUILD_COMMIT_SHA ?? "dev").trim() || "dev",
    buildTime: new Date().toISOString(),
    analyticsEnabled: false
  };

  try {
    const raw = await readFile(resolve(process.cwd(), "dist/build-meta.json"), "utf8");
    const parsed = buildMetaSchema.parse(JSON.parse(raw));
    return {
      commitSha: parsed.commitSha,
      buildTime: parsed.buildTime,
      analyticsEnabled: false
    };
  } catch {
    return fallback;
  }
}

if (env.STORE_DRIVER === "postgres" && env.RUN_MIGRATIONS_ON_BOOT) {
  await runMigrations();
}

await initStore();
await initAuth(users);
const buildMetadata = await loadBuildMetadata();

const { app, attachRealtime } = await createBridgeApp(env.CORS_ORIGIN, {
  auth: { mode: env.AUTH_MODE },
  build: buildMetadata
});
const server = await app.listen({ port: env.PORT, host: "0.0.0.0" });
attachRealtime();
startSessionCleanup();

app.log.info(`Bridge API listening on ${server}`);

let shuttingDown = false;
let forceExitTimer: NodeJS.Timeout | null = null;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    app.log.warn({ signal }, "shutdown already in progress");
    return;
  }
  shuttingDown = true;
  app.log.info({ signal, timeoutMs: env.SHUTDOWN_TIMEOUT_MS }, "shutting down...");

  forceExitTimer = setTimeout(() => {
    app.log.error("shutdown timeout reached, forcing exit");
    process.exit(1);
  }, env.SHUTDOWN_TIMEOUT_MS);
  forceExitTimer.unref?.();

  stopSessionCleanup();
  try {
    await app.close();
    await closeDbPool();
    if (forceExitTimer) {
      clearTimeout(forceExitTimer);
      forceExitTimer = null;
    }
    process.exit(0);
  } catch (error) {
    app.log.error(
      { error: error instanceof Error ? error.message : "unknown error" },
      "graceful shutdown failed"
    );
    process.exit(1);
  }
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
