import { messageOf } from "@incident-resolver/shared";
import { getConfig } from "@incident-resolver/shared/config";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Pool } from "pg";
import { resolveReporter } from "./reporter";
import { createDatabaseServer } from "./server";

/**
 * Stdio entry point, spawned by portal-api per Ticket.
 *
 * Environment: SHOPLITE_READONLY_DATABASE_URL and QUERY_ROW_CAP from the shared config,
 * plus REPORTER_CUSTOMER_ID or REPORTER_EMAIL for customer Tickets. Leave both unset for
 * tester and Sentinel Tickets, which run unscoped. The reporter is read straight from the
 * environment rather than config.ts because it is per-Ticket spawn context, not a tunable.
 */
const config = getConfig();
const pool = new Pool({ connectionString: config.infra.shopliteReadonlyDatabaseUrl });

try {
  const reporter = await resolveReporter(pool, {
    customerId: process.env.REPORTER_CUSTOMER_ID,
    email: process.env.REPORTER_EMAIL,
  });
  const server = createDatabaseServer({ pool, reporter, rowCap: config.queryRowCap });
  server.server.onclose = () => {
    void pool.end();
  };
  await server.connect(new StdioServerTransport());
  console.error(
    reporter
      ? `mcp-database ready, scoped to customer ${reporter.customerId}`
      : "mcp-database ready, unscoped",
  );
} catch (error) {
  console.error(`mcp-database failed to start: ${messageOf(error)}`);
  await pool.end();
  process.exit(1);
}
