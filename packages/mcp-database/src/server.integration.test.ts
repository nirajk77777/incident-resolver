import { fileURLToPath } from "node:url";
import {
  createDb,
  type DataFixProposal,
  loadConfig,
  runMigrations,
} from "@incident-resolver/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { QueryResult } from "./server";

// Needs `docker compose up`, this repo's `pnpm db:migrate`, and ShopLite's
// `pnpm db:migrate && pnpm db:seed`. Run with `pnpm test:integration`.
//
// Every assertion goes through the MCP client over stdio, the way portal-api will use
// the server, except the one that proves Postgres itself refuses writes from the role.

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const config = loadConfig();

const ava = { id: "00000000-0000-4000-8000-000000000001", email: "ava.chen@example.com" };
const liam = { id: "00000000-0000-4000-8000-000000000002", email: "liam.okafor@example.com" };
const fixture = {
  avaCart: "10000000-0000-4000-8000-000000000001",
  liamCart: "10000000-0000-4000-8000-000000000002",
  avaOrder: "20000000-0000-4000-8000-000000000001",
  liamOrder: "20000000-0000-4000-8000-000000000002",
};

type ToolReply = { text: string; isError: boolean };

async function startServer(env: Record<string, string>): Promise<Client> {
  const client = new Client({ name: "mcp-database-test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/main.ts"],
      cwd: packageDir,
      env: { ...(process.env as Record<string, string>), ...env },
      stderr: "pipe",
    }),
  );
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const [first] = result.content as Array<{ type: string; text: string }>;
  return { text: first?.text ?? "", isError: result.isError === true } satisfies ToolReply;
}

async function query(client: Client, sql: string): Promise<QueryResult> {
  const reply = await call(client, "run_readonly_sql", { sql });
  expect(reply.isError, reply.text).toBe(false);
  return JSON.parse(reply.text) as QueryResult;
}

describe("mcp-database over the MCP client", () => {
  const admin = createDb(config.infra.databaseUrl);
  let unscoped: Client;
  let scoped: Client;
  let capped: Client;

  beforeAll(async () => {
    await runMigrations(admin);
    const seeded = await admin.$client.query("SELECT 1 FROM shoplite.customers WHERE id = $1", [
      ava.id,
    ]);
    if (seeded.rowCount === 0) {
      throw new Error("ShopLite is not seeded: run `pnpm db:migrate && pnpm db:seed` in shoplite");
    }
    await admin.$client.query(
      `INSERT INTO shoplite.carts (id, customer_id, status) VALUES ($1, $3, 'checked_out'), ($2, $4, 'checked_out')`,
      [fixture.avaCart, fixture.liamCart, ava.id, liam.id],
    );
    await admin.$client.query(
      `INSERT INTO shoplite.orders (id, customer_id, cart_id, subtotal_cents, discount_cents, total_cents, lines)
       VALUES ($1, $3, $5, 1200, 0, 1200, '[]'), ($2, $4, $6, 2599, 0, 2599, '[]')`,
      [fixture.avaOrder, fixture.liamOrder, ava.id, liam.id, fixture.avaCart, fixture.liamCart],
    );
    await admin.$client.query(
      `INSERT INTO shoplite.payments (customer_id, cart_id, amount_cents, card_last4, status, decline_code, decline_message)
       VALUES ($1, $2, 1200, '0002', 'declined', 'insufficient_funds', 'Card declined by issuer: insufficient funds')`,
      [ava.id, fixture.avaCart],
    );

    [unscoped, scoped, capped] = await Promise.all([
      startServer({}),
      startServer({ REPORTER_CUSTOMER_ID: ava.id }),
      startServer({ QUERY_ROW_CAP: "3" }),
    ]);
  });

  afterAll(async () => {
    await Promise.all([unscoped, scoped, capped].map((client) => client?.close()));
    await admin.$client.query("DELETE FROM shoplite.payments WHERE cart_id = ANY($1)", [
      [fixture.avaCart, fixture.liamCart],
    ]);
    await admin.$client.query("DELETE FROM shoplite.orders WHERE id = ANY($1)", [
      [fixture.avaOrder, fixture.liamOrder],
    ]);
    await admin.$client.query("DELETE FROM shoplite.carts WHERE id = ANY($1)", [
      [fixture.avaCart, fixture.liamCart],
    ]);
    await admin.$client.end();
  });

  it("exposes the three tools", async () => {
    const { tools } = await unscoped.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "describe_schema",
      "propose_data_fix",
      "run_readonly_sql",
    ]);
  });

  it("describes the ShopLite tables with their columns and constraints", async () => {
    const reply = await call(unscoped, "describe_schema");
    expect(reply.isError).toBe(false);
    for (const table of ["customers", "carts", "cart_items", "cart_totals", "orders", "payments"]) {
      expect(reply.text).toContain(`## ${table}`);
    }
    expect(reply.text).toContain("- card_last4: text, not null");
    expect(reply.text).toMatch(/FOREIGN KEY \(customer_id\) REFERENCES customers\(id\)/);
    expect(reply.text).not.toContain("__drizzle_migrations");
  });

  it("tells a customer Ticket which filter its queries need", async () => {
    const reply = await call(scoped, "describe_schema");
    expect(reply.text).toContain(`customer_id = '${ava.id}'`);
  });

  describe("read-only enforcement", () => {
    it("refuses a write through the tool and points at propose_data_fix", async () => {
      const reply = await call(unscoped, "run_readonly_sql", {
        sql: "UPDATE shoplite.products SET name = 'x' WHERE sku = 'MUG-01'",
      });
      expect(reply.isError).toBe(true);
      expect(reply.text).toContain("propose_data_fix");
    });

    it("refuses a write hidden in a CTE", async () => {
      const reply = await call(unscoped, "run_readonly_sql", {
        sql: "WITH x AS (DELETE FROM shoplite.cart_items RETURNING *) SELECT count(*) FROM x",
      });
      expect(reply.isError).toBe(true);
    });

    it("connects as a role that Postgres itself stops from writing", async () => {
      const reader = new PgClient({ connectionString: config.infra.shopliteReadonlyDatabaseUrl });
      await reader.connect();
      try {
        await expect(reader.query("UPDATE shoplite.products SET name = 'x'")).rejects.toThrow(
          /read-only transaction/,
        );
        // Even with the session default switched off, the role has no privilege to write.
        await reader.query("SET default_transaction_read_only = off");
        await expect(reader.query("UPDATE shoplite.products SET name = 'x'")).rejects.toThrow(
          /permission denied for table products/,
        );
        await expect(reader.query("SELECT * FROM portal.tickets")).rejects.toThrow(
          /permission denied for schema portal/,
        );
      } finally {
        await reader.end();
      }
    });
  });

  describe("tenant scoping for a customer Ticket", () => {
    it("rejects a query that does not filter by the reporter and says what to add", async () => {
      const reply = await call(scoped, "run_readonly_sql", {
        sql: "SELECT id, customer_id FROM orders",
      });
      expect(reply.isError).toBe(true);
      expect(reply.text).toContain("customer Ticket");
      expect(reply.text).toContain(`customer_id = '${ava.id}'`);
    });

    it("returns only the reporter's rows when the filter is present", async () => {
      const result = await query(
        scoped,
        `SELECT id, customer_id FROM orders WHERE customer_id = '${ava.id}' ORDER BY created_at`,
      );
      expect(result.rows.map((row) => row.id)).toEqual([fixture.avaOrder]);
      expect(result.columns).toEqual(["id", "customer_id"]);
    });

    it("lets a tester Ticket read across customers", async () => {
      const result = await query(
        unscoped,
        "SELECT id FROM orders WHERE id = ANY(ARRAY['20000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002']::uuid[]) ORDER BY id",
      );
      expect(result.rows.map((row) => row.id)).toEqual([fixture.avaOrder, fixture.liamOrder]);
    });

    it("accepts a reporter given by email and scopes the same way", async () => {
      const byEmail = await startServer({ REPORTER_EMAIL: ava.email.toUpperCase() });
      try {
        const reply = await call(byEmail, "run_readonly_sql", { sql: "SELECT * FROM payments" });
        expect(reply.isError).toBe(true);
        expect(reply.text).toContain(ava.id);
      } finally {
        await byEmail.close();
      }
    });

    it("refuses to start for a reporter who is not a ShopLite customer", async () => {
      await expect(startServer({ REPORTER_EMAIL: "nobody@example.com" })).rejects.toThrow();
    });
  });

  describe("redaction", () => {
    it("masks every email for a tester Ticket", async () => {
      const result = await query(unscoped, "SELECT email FROM customers ORDER BY email");
      expect(result.rows).toHaveLength(5);
      expect(result.rows.every((row) => row.email === "[redacted email]")).toBe(true);
    });

    it("keeps the reporter's email and masks other people's", async () => {
      const own = await query(scoped, `SELECT email FROM customers WHERE id = '${ava.id}'`);
      expect(own.rows).toEqual([{ email: ava.email }]);

      const other = await query(scoped, `SELECT '${liam.email}' AS pasted`);
      expect(other.rows).toEqual([{ pasted: "[redacted email]" }]);
    });

    it("masks card numbers entirely while keeping ids and last-four digits", async () => {
      const result = await query(
        scoped,
        `SELECT id, card_last4, decline_message, 'paid with 4242 4242 4242 4242' AS note
         FROM payments WHERE customer_id = '${ava.id}'`,
      );
      const [row] = result.rows;
      expect(row?.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(row?.card_last4).toBe("0002");
      expect(row?.decline_message).toBe("Card declined by issuer: insufficient funds");
      expect(row?.note).toBe("paid with [redacted card]");
    });
  });

  describe("row cap", () => {
    it("truncates results at the configured cap and says so", async () => {
      const result = await query(capped, "SELECT sku FROM products ORDER BY sku");
      expect(result.rows).toHaveLength(3);
      expect(result).toMatchObject({ rowCount: 3, truncated: true, rowCap: 3 });
    });

    it("reports untruncated results as such", async () => {
      const result = await query(capped, "SELECT code FROM discount_codes");
      expect(result).toMatchObject({ rowCount: 3, truncated: false });
    });
  });

  describe("propose_data_fix", () => {
    it("returns a Proposal with the SQL, the reason, and the rows it would touch, and writes nothing", async () => {
      const reply = await call(unscoped, "propose_data_fix", {
        sql: "UPDATE shoplite.products SET name = 'Renamed' WHERE sku = 'MUG-01'",
        reason: "The catalog row is mislabelled",
      });
      expect(reply.isError, reply.text).toBe(false);
      const proposal = JSON.parse(reply.text) as DataFixProposal;
      expect(proposal).toEqual({
        kind: "data_fix",
        statement: "update",
        table: "shoplite.products",
        sql: "UPDATE shoplite.products SET name = 'Renamed' WHERE sku = 'MUG-01'",
        reason: "The catalog row is mislabelled",
        matchingRows: 1,
        executed: false,
      });

      const { rows } = await admin.$client.query<{ name: string }>(
        "SELECT name FROM shoplite.products WHERE sku = 'MUG-01'",
      );
      expect(rows[0]?.name).toBe("Stoneware Mug");
    });

    it("rejects a fix without a WHERE clause", async () => {
      const reply = await call(unscoped, "propose_data_fix", {
        sql: "DELETE FROM shoplite.cart_items",
        reason: "clean up",
      });
      expect(reply.isError).toBe(true);
      expect(reply.text).toContain("WHERE");
    });

    it("applies the reporter scope to a customer Ticket's fix", async () => {
      const unfiltered = await call(scoped, "propose_data_fix", {
        sql: `UPDATE cart_totals SET item_count = 0 WHERE cart_id = '${fixture.avaCart}'`,
        reason: "stale badge",
      });
      expect(unfiltered.isError).toBe(true);

      const filtered = await call(scoped, "propose_data_fix", {
        sql: `UPDATE cart_totals SET item_count = 0 WHERE cart_id IN (SELECT id FROM carts WHERE customer_id = '${ava.id}')`,
        reason: "stale badge",
      });
      expect(filtered.isError, filtered.text).toBe(false);
      expect(JSON.parse(filtered.text)).toMatchObject({
        table: "shoplite.cart_totals",
        executed: false,
      });
    });
  });
});
