import { getConfig } from "../src/config";
import { createDb } from "../src/db/client";
import { runMigrations } from "../src/db/migrate";

const { databaseUrl } = getConfig().infra;
const db = createDb(databaseUrl);
try {
  await runMigrations(db);
  console.log(`Migrations applied to ${databaseUrl.replace(/\/\/.*@/, "//***@")}`);
} finally {
  await db.$client.end();
}
