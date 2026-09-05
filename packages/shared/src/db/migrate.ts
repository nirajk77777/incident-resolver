import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Db } from "./client";

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

/** Applies every pending migration in `packages/shared/drizzle`. */
export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder });
}
