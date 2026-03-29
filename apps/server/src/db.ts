import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;

const migrationsDir = join(fileURLToPath(new URL("../migrations", import.meta.url)));

let pool: pg.Pool | null = null;

function getDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  return databaseUrl;
}

export function getDbPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: getDatabaseUrl()
    });
  }
  return pool;
}

export async function closeDbPool(): Promise<void> {
  if (!pool) {
    return;
  }
  await pool.end();
  pool = null;
}

export async function runMigrations(): Promise<void> {
  const migrationFiles = ["001_init.sql"];
  const db = getDbPool();
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  for (const file of migrationFiles) {
    const exists = await db.query<{ version: string }>(
      "SELECT version FROM schema_migrations WHERE version = $1",
      [file]
    );
    if (exists.rowCount && exists.rowCount > 0) {
      continue;
    }

    const sql = await readFile(join(migrationsDir, file), "utf8");
    await db.query("BEGIN");
    try {
      await db.query(sql);
      await db.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
      await db.query("COMMIT");
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    }
  }
}
