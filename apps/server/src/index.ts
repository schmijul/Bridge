import { z } from "zod";
import { createBridgeApp } from "./app.js";

const envSchema = z.object({
  PORT: z.coerce.number().default(4000),
  CORS_ORIGIN: z.string().default("http://localhost:5173")
});

const env = envSchema.parse(process.env);

const { app, attachRealtime } = await createBridgeApp(env.CORS_ORIGIN);
const server = await app.listen({ port: env.PORT, host: "0.0.0.0" });
attachRealtime();

app.log.info(`Bridge API listening on ${server}`);
