import { z } from "zod";
import { createBridgeApp } from "./app.js";
import { runMigrations } from "./db.js";
import { initStore, users } from "./store.js";
import { initAuth } from "./auth.js";

const envSchema = z.object({
  PORT: z.coerce.number().default(4000),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  AUTH_MODE: z.enum(["local", "oidc"]).default("local"),
  STORE_DRIVER: z.enum(["memory", "postgres"]).default("memory"),
  RUN_MIGRATIONS_ON_BOOT: z
    .string()
    .transform((value) => value.toLowerCase() === "true")
    .default("false")
});

const env = envSchema.parse(process.env);

if (env.STORE_DRIVER === "postgres" && env.RUN_MIGRATIONS_ON_BOOT) {
  await runMigrations();
}

await initStore();
await initAuth(users);

const { app, attachRealtime } = await createBridgeApp(env.CORS_ORIGIN, {
  auth: { mode: env.AUTH_MODE }
});
const server = await app.listen({ port: env.PORT, host: "0.0.0.0" });
attachRealtime();

app.log.info(`Bridge API listening on ${server}`);
