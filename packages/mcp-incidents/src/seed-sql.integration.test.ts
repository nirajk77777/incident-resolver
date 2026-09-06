import { createDb, loadConfig } from "@incident-resolver/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cartTotalsRecomputeSql } from "./seed-data";

// Needs `docker compose up` and ShopLite's `pnpm db:migrate && pnpm db:seed`, no Cohere.
// Proves the UPDATE the seeded Incidents document really restores a cart_totals row the
// way ShopLite's own pricing would, for every discount case. Everything is rolled back.

type Totals = {
  item_count: number;
  subtotal_cents: number;
  discount_cents: number;
  total_cents: number;
};

describe("the documented cart_totals recompute", () => {
  const db = createDb(loadConfig().infra.databaseUrl);
  let cartId: string;
  let subtotal: number;

  beforeAll(async () => {
    await db.$client.query("BEGIN");
    const { rows: carts } = await db.$client.query<{ id: string }>(
      "SELECT id FROM shoplite.carts WHERE status = 'open' LIMIT 1",
    );
    const { rows: products } = await db.$client.query<{ id: string; price_cents: number }>(
      "SELECT id, price_cents FROM shoplite.products ORDER BY sku LIMIT 2",
    );
    const [cart] = carts;
    const [first, second] = products;
    if (!cart || !first || !second) {
      throw new Error("ShopLite is not seeded: run `pnpm db:migrate && pnpm db:seed` in shoplite");
    }
    cartId = cart.id;
    subtotal = 2 * first.price_cents + second.price_cents;
    await db.$client.query("DELETE FROM shoplite.cart_items WHERE cart_id = $1", [cartId]);
    await db.$client.query(
      `INSERT INTO shoplite.cart_items (cart_id, product_id, unit_price_cents, quantity)
       VALUES ($1, $2, $3, 2), ($1, $4, $5, 1)`,
      [cartId, first.id, first.price_cents, second.id, second.price_cents],
    );
  });

  afterAll(async () => {
    await db.$client.query("ROLLBACK");
    await db.$client.end();
  });

  async function recomputeWith(code: string | null): Promise<Totals> {
    await db.$client.query("UPDATE shoplite.carts SET discount_code = $2 WHERE id = $1", [
      cartId,
      code,
    ]);
    await db.$client.query(
      `UPDATE shoplite.cart_totals SET item_count = 99, subtotal_cents = 1, discount_cents = 1, total_cents = 1
       WHERE cart_id = $1`,
      [cartId],
    );
    await db.$client.query(cartTotalsRecomputeSql.replaceAll("<cart id>", cartId));
    const { rows } = await db.$client.query<Totals>(
      `SELECT item_count, subtotal_cents, discount_cents, total_cents
       FROM shoplite.cart_totals WHERE cart_id = $1`,
      [cartId],
    );
    return rows[0] as Totals;
  }

  it("restores count and subtotal with no discount code", async () => {
    expect(await recomputeWith(null)).toEqual({
      item_count: 3,
      subtotal_cents: subtotal,
      discount_cents: 0,
      total_cents: subtotal,
    });
  });

  it("applies a percentage code the way ShopLite rounds it", async () => {
    const off = Math.round((subtotal * 10) / 100);
    expect(await recomputeWith("SALE10")).toMatchObject({
      discount_cents: off,
      total_cents: subtotal - off,
    });
  });

  it("applies a fixed code only above its minimum subtotal", async () => {
    const off = subtotal >= 2000 ? 500 : 0;
    expect(await recomputeWith("FLAT5")).toMatchObject({
      discount_cents: off,
      total_cents: subtotal - off,
    });
  });

  it("ignores an inactive code", async () => {
    expect(await recomputeWith("EXPIRED20")).toMatchObject({
      discount_cents: 0,
      total_cents: subtotal,
    });
  });
});
