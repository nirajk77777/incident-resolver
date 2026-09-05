import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

export type Db = NodePgDatabase & { $client: Pool };

/** Opens a connection pool. Close it with `db.$client.end()`. */
export function createDb(databaseUrl: string): Db {
  return drizzle({ client: new Pool({ connectionString: databaseUrl }) });
}
