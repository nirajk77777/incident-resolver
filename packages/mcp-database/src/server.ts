import { type DataFixProposal, messageOf, redact } from "@incident-resolver/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Pool } from "pg";
import { z } from "zod";
import { describeSchema, formatSchema } from "./describe-schema";
import type { Reporter } from "./reporter";
import { checkDataFixSql, checkReadonlySql, tenantTableList } from "./sql-guard";

export type DatabaseServerOptions = {
  /** Connected as the SELECT-only role, see migration 0002. */
  pool: Pool;
  /** Present for customer Tickets: scopes queries and keeps this email unmasked. */
  reporter?: Reporter | undefined;
  /** Rows a read-only query returns before being truncated. */
  rowCap: number;
};

export type QueryResult = {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  rowCap: number;
};

/** Builds the `mcp-database` server. Connect it to a transport to serve. */
export function createDatabaseServer(options: DatabaseServerOptions): McpServer {
  const { pool, reporter, rowCap } = options;
  const scope = reporter ? { reporterCustomerId: reporter.customerId } : undefined;
  const redacted = <T>(value: T): T => redact(value, { reporterEmail: reporter?.email });
  const scopeNote = reporter
    ? ` This is a customer Ticket: every SELECT on ${tenantTableList} must filter by customer_id = '${reporter.customerId}'.`
    : "";

  const server = new McpServer({ name: "mcp-database", version: "0.0.0" });

  server.registerTool(
    "describe_schema",
    {
      title: "Describe the ShopLite schema",
      description:
        "Tables, columns, types, and constraints of the ShopLite database. Call this before writing SQL.",
      annotations: { readOnlyHint: true },
    },
    async () => text(formatSchema(await describeSchema(pool), reporter)),
  );

  server.registerTool(
    "run_readonly_sql",
    {
      title: "Run a read-only query",
      description:
        "Runs one SELECT against ShopLite through a SELECT-only role. " +
        `At most ${rowCap} rows come back, and card numbers and other people's emails are masked.${scopeNote}`,
      inputSchema: { sql: z.string().describe("A single SELECT statement") },
      annotations: { readOnlyHint: true },
    },
    async ({ sql }) => {
      const check = checkReadonlySql(sql, scope);
      if (!check.ok) return failure(check.reason);
      try {
        const result = await pool.query(
          `SELECT * FROM (\n${check.sql}\n) AS result LIMIT ${rowCap + 1}`,
        );
        const rows = result.rows.slice(0, rowCap) as Record<string, unknown>[];
        const payload: QueryResult = {
          columns: result.fields.map((field) => field.name),
          rows: redacted(JSON.parse(JSON.stringify(rows))),
          rowCount: rows.length,
          truncated: result.rows.length > rowCap,
          rowCap,
        };
        return text(JSON.stringify(payload, null, 2));
      } catch (error) {
        return failure(`Query failed: ${redacted(messageOf(error))}`);
      }
    },
  );

  server.registerTool(
    "propose_data_fix",
    {
      title: "Propose a data fix",
      description:
        "Proposes an UPDATE or DELETE with a WHERE clause to correct ShopLite data. Nothing runs here: " +
        "the Proposal goes to a human Reviewer in the portal, who approves, edits, or rejects it. " +
        `Give the reason with the Evidence behind it.${scopeNote}`,
      inputSchema: {
        sql: z.string().describe("A single UPDATE or DELETE statement with a WHERE clause"),
        reason: z.string().describe("Why this fix is right, citing the Evidence"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ sql, reason }) => {
      const check = checkDataFixSql(sql, scope);
      if (!check.ok) return failure(check.reason);
      const proposal: DataFixProposal = {
        kind: "data_fix",
        statement: check.statement,
        table: check.table,
        sql: sql.trim(),
        reason,
        matchingRows: await countMatching(pool, check.table, check.where),
        executed: false,
      };
      return text(JSON.stringify(redacted(proposal), null, 2));
    },
  );

  return server;
}

async function countMatching(pool: Pool, table: string, where: string): Promise<number | null> {
  try {
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`,
    );
    return rows[0]?.n ?? null;
  } catch {
    return null;
  }
}

function text(value: string): CallToolResult {
  return { content: [{ type: "text", text: value }] };
}

function failure(reason: string): CallToolResult {
  return { content: [{ type: "text", text: reason }], isError: true };
}
