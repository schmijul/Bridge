import { closeDbPool, runMigrations } from "./db.js";

async function main() {
  await runMigrations();
  await closeDbPool();
}

main().catch(async (error) => {
  console.error(error);
  await closeDbPool();
  process.exit(1);
});
