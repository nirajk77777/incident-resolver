import { loadConfig } from "@incident-resolver/shared";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDataFixRunner, type DataFixRunner } from "./data-fix";

// Needs `docker compose up` and `pnpm db:migrate`. Run with `pnpm test:integration`.
//
// The write role, the transaction, the row cap and the snapshot are the whole of the guard
// on an approved data fix, so every assertion here runs real SQL as the real role.

const config = loadConfig();
let admin: Pool;
let runner: DataFixRunner;
/** A cart of this test's own, so nothing here depends on or disturbs the seeded data. */
let cartId: string;
let otherCartId: string;
let customerId: string;

async function totalOf(id: string): Promise<number | undefined> {
  const { rows } = await admin.query<{ total_cents: number }>(
    "SELECT total_cents FROM shoplite.cart_totals WHERE cart_id = $1",
    [id],
  );
  return rows[0]?.total_cents;
}

async function makeCart(total: number): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    "INSERT INTO shoplite.carts (customer_id, status) VALUES ($1, 'open') RETURNING id",
    [customerId],
  );
  const id = rows[0]?.id as string;
  await admin.query(
    "INSERT INTO shoplite.cart_totals (cart_id, item_count, subtotal_cents, total_cents) VALUES ($1, 2, $2, $2)",
    [id, total],
  );
  return id;
}

beforeAll(async () => {
  admin = new Pool({ connectionString: config.infra.databaseUrl });
  const { rows } = await admin.query<{ id: string }>(
    "INSERT INTO shoplite.customers (email, name) VALUES ($1, 'Data Fix Test') RETURNING id",
    [`data-fix-${Date.now()}@example.com`],
  );
  customerId = rows[0]?.id as string;
  cartId = await makeCart(4200);
  otherCartId = await makeCart(999);
  runner = createDataFixRunner({
    databaseUrl: config.infra.shopliteWriteDatabaseUrl,
    rowCap: config.dataFixRowCap,
  });
});

afterAll(async () => {
  await runner.close();
  if (customerId) {
    // Carts do not cascade from their customer, so they go first.
    await admin.query("DELETE FROM shoplite.carts WHERE customer_id = $1", [customerId]);
    await admin.query("DELETE FROM shoplite.customers WHERE id = $1", [customerId]);
  }
  await admin.end();
});

describe("previewing what a fix would touch", () => {
  it("returns the rows the WHERE clause matches, as they are now", async () => {
    const preview = await runner.preview(
      `UPDATE shoplite.cart_totals SET total_cents = 1200 WHERE cart_id = '${cartId}'`,
    );

    expect(preview).toMatchObject({ table: "shoplite.cart_totals", statement: "update" });
    if (!preview.ok) throw new Error(preview.reason);
    expect(preview.rowCount).toBe(1);
    expect(preview.rows[0]).toMatchObject({ cart_id: cartId, total_cents: 4200 });
    // Reading what a fix would do changes nothing.
    expect(await totalOf(cartId)).toBe(4200);
  });

  it("refuses to preview a statement the portal would never run", async () => {
    const preview = await runner.preview("DELETE FROM shoplite.orders");
    expect(preview.ok).toBe(false);
  });
});

describe("running an approved fix", () => {
  it("corrects the row and keeps the rows it changed as they were", async () => {
    const applied = await runner.apply(
      `UPDATE shoplite.cart_totals SET total_cents = 1200 WHERE cart_id = '${cartId}'`,
    );

    if (!applied.ok) throw new Error(applied.reason);
    expect(applied).toMatchObject({
      statement: "update",
      table: "shoplite.cart_totals",
      rowCount: 1,
    });
    expect(applied.snapshot[0]).toMatchObject({ cart_id: cartId, total_cents: 4200 });
    expect(await totalOf(cartId)).toBe(1200);
    // The snapshot is enough to put it back.
    expect(await totalOf(otherCartId)).toBe(999);
  });

  it("changes nothing when the fix matches more rows than the cap", async () => {
    const capped = createDataFixRunner({
      databaseUrl: config.infra.shopliteWriteDatabaseUrl,
      rowCap: 1,
    });
    try {
      const applied = await capped.apply(
        `UPDATE shoplite.cart_totals SET total_cents = 0 WHERE cart_id IN ('${cartId}', '${otherCartId}')`,
      );
      expect(applied.ok).toBe(false);
      if (!applied.ok) expect(applied.reason).toMatch(/cap/);
      expect(await totalOf(cartId)).toBe(1200);
      expect(await totalOf(otherCartId)).toBe(999);
    } finally {
      await capped.close();
    }
  });

  it("changes nothing when the statement fails, and says so", async () => {
    const applied = await runner.apply(
      `UPDATE shoplite.cart_totals SET total_cents = 'not a number' WHERE cart_id = '${cartId}'`,
    );
    expect(applied.ok).toBe(false);
    if (!applied.ok) expect(applied.reason).toMatch(/nothing was changed/);
    expect(await totalOf(cartId)).toBe(1200);
  });
});

describe("what the writing role itself allows", () => {
  const write = () => new Pool({ connectionString: config.infra.shopliteWriteDatabaseUrl, max: 1 });

  it("refuses an INSERT and any write outside the ShopLite schema, whatever the tool layer does", async () => {
    const pool = write();
    try {
      await expect(
        pool.query("INSERT INTO shoplite.cart_totals (cart_id) VALUES (gen_random_uuid())"),
      ).rejects.toThrow(/permission denied/i);
      await expect(pool.query("DELETE FROM portal.tickets")).rejects.toThrow(/permission denied/i);
    } finally {
      await pool.end();
    }
  });
});
