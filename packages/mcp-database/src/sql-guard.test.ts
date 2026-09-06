import { describe, expect, it } from "vitest";
import { checkDataFixSql, checkReadonlySql } from "./sql-guard";

const ava = "00000000-0000-4000-8000-000000000001";
const liam = "00000000-0000-4000-8000-000000000002";
const scoped = { reporterCustomerId: ava };

describe("checkReadonlySql without a reporter scope", () => {
  it("accepts a plain SELECT and hands back the statement without its trailing semicolon", () => {
    expect(checkReadonlySql("  SELECT * FROM shoplite.orders;  ")).toEqual({
      ok: true,
      sql: "SELECT * FROM shoplite.orders",
    });
  });

  it("accepts CTEs and unions", () => {
    expect(checkReadonlySql("WITH o AS (SELECT id FROM orders) SELECT * FROM o").ok).toBe(true);
    expect(checkReadonlySql("SELECT id FROM orders UNION SELECT id FROM payments").ok).toBe(true);
  });

  it("accepts a SELECT that reads no table", () => {
    expect(checkReadonlySql("SELECT now()").ok).toBe(true);
  });

  it.each([
    "UPDATE shoplite.products SET name = 'x'",
    "DELETE FROM shoplite.cart_items",
    "INSERT INTO shoplite.products (sku) VALUES ('x')",
    "TRUNCATE shoplite.orders",
    "DROP TABLE shoplite.orders",
    "VALUES (1)",
    "SHOW search_path",
  ])("rejects a non-SELECT statement and points at propose_data_fix: %s", (sql) => {
    const result = checkReadonlySql(sql);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/single SELECT.*propose_data_fix/s);
  });

  it("rejects a data-modifying CTE hidden inside a SELECT", () => {
    const result = checkReadonlySql(
      "WITH x AS (UPDATE shoplite.products SET name = 'x' RETURNING *) SELECT * FROM x",
    );
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/single SELECT/) });
  });

  it("rejects more than one statement", () => {
    const result = checkReadonlySql("SELECT 1; SELECT 2");
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/one statement/i) });
  });

  it("rejects SQL it cannot parse and quotes the parser", () => {
    const result = checkReadonlySql("SELEC * FROM orders");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/Syntax error/);
  });

  it("does not ask for a customer filter", () => {
    expect(checkReadonlySql("SELECT * FROM shoplite.orders").ok).toBe(true);
  });
});

describe("checkReadonlySql for a customer Ticket", () => {
  it.each([
    `SELECT * FROM shoplite.orders WHERE customer_id = '${ava}'`,
    `SELECT * FROM orders WHERE '${ava}' = customer_id`,
    `SELECT * FROM orders o WHERE o.customer_id = '${ava}'::uuid AND o.status = 'paid'`,
    `SELECT * FROM orders o JOIN payments p ON p.order_id = o.id WHERE p.status = 'declined' AND o.customer_id = '${ava.toUpperCase()}'`,
    `SELECT * FROM shoplite.customers WHERE id = '${ava}'`,
    `SELECT * FROM customers c WHERE c.id = '${ava}'`,
  ])("accepts a query filtered by the reporter: %s", (sql) => {
    expect(checkReadonlySql(sql, scoped).ok).toBe(true);
  });

  it("accepts tables that belong to no customer without a filter", () => {
    expect(checkReadonlySql("SELECT * FROM shoplite.products", scoped).ok).toBe(true);
    expect(checkReadonlySql("SELECT * FROM discount_codes WHERE active", scoped).ok).toBe(true);
    expect(checkReadonlySql("SELECT 1", scoped).ok).toBe(true);
  });

  it("rejects a query on a customer-owned table with no filter and explains what to add", () => {
    const result = checkReadonlySql("SELECT * FROM shoplite.orders", scoped);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("customer Ticket");
      expect(result.reason).toContain(`customer_id = '${ava}'`);
      expect(result.reason).toContain("orders");
    }
  });

  it("rejects a filter for a different customer", () => {
    expect(checkReadonlySql(`SELECT * FROM orders WHERE customer_id = '${liam}'`, scoped).ok).toBe(
      false,
    );
  });

  it("rejects a filter weakened by OR", () => {
    expect(
      checkReadonlySql(`SELECT * FROM orders WHERE customer_id = '${ava}' OR true`, scoped).ok,
    ).toBe(false);
  });

  it("rejects an id filter on a table where id is not the customer", () => {
    expect(checkReadonlySql(`SELECT * FROM orders WHERE id = '${ava}'`, scoped).ok).toBe(false);
  });

  it("accepts cart tables reached through a filtered carts subquery", () => {
    expect(
      checkReadonlySql(
        `SELECT * FROM cart_items WHERE cart_id IN (SELECT id FROM carts WHERE customer_id = '${ava}')`,
        scoped,
      ).ok,
    ).toBe(true);
    expect(
      checkReadonlySql(
        `SELECT * FROM cart_totals ct WHERE EXISTS (SELECT 1 FROM carts c WHERE c.id = ct.cart_id AND c.customer_id = '${ava}')`,
        scoped,
      ).ok,
    ).toBe(true);
  });

  it("rejects cart tables reached through an unfiltered subquery", () => {
    expect(
      checkReadonlySql("SELECT * FROM cart_items WHERE cart_id IN (SELECT id FROM carts)", scoped)
        .ok,
    ).toBe(false);
  });

  it("checks CTEs, derived tables, and both sides of a union", () => {
    expect(
      checkReadonlySql(
        `WITH mine AS (SELECT id FROM carts WHERE customer_id = '${ava}') SELECT * FROM cart_totals WHERE cart_id IN (SELECT id FROM mine)`,
        scoped,
      ).ok,
    ).toBe(true);
    expect(
      checkReadonlySql("WITH mine AS (SELECT id FROM carts) SELECT * FROM mine", scoped).ok,
    ).toBe(false);
    expect(
      checkReadonlySql(
        `SELECT count(*) FROM (SELECT * FROM orders WHERE customer_id = '${ava}') o`,
        scoped,
      ).ok,
    ).toBe(true);
    expect(checkReadonlySql("SELECT count(*) FROM (SELECT * FROM orders) o", scoped).ok).toBe(
      false,
    );
    expect(
      checkReadonlySql(
        `SELECT id FROM orders WHERE customer_id = '${ava}' UNION SELECT id FROM payments`,
        scoped,
      ).ok,
    ).toBe(false);
  });

  it("rejects tables outside ShopLite, so metadata comes from describe_schema", () => {
    const result = checkReadonlySql("SELECT * FROM information_schema.columns", scoped);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/describe_schema/);
  });
});

describe("checkDataFixSql", () => {
  it("accepts an UPDATE with a WHERE clause and reports the target", () => {
    expect(
      checkDataFixSql(
        "UPDATE shoplite.cart_totals SET item_count = 2, total_cents = 2400 WHERE cart_id = 'c1'",
      ),
    ).toEqual({
      ok: true,
      statement: "update",
      table: "shoplite.cart_totals",
      where: "(cart_id = ('c1'))",
    });
  });

  it("accepts a DELETE with a WHERE clause on an unqualified table", () => {
    expect(checkDataFixSql("DELETE FROM cart_items WHERE id = 'x'")).toEqual({
      ok: true,
      statement: "delete",
      table: "shoplite.cart_items",
      where: "(id = ('x'))",
    });
  });

  it("rejects an UPDATE or DELETE without WHERE", () => {
    const result = checkDataFixSql("UPDATE shoplite.products SET name = 'x'");
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/WHERE/) });
    expect(checkDataFixSql("DELETE FROM shoplite.cart_items").ok).toBe(false);
  });

  it.each([
    "SELECT * FROM shoplite.orders",
    "INSERT INTO shoplite.products (sku) VALUES ('x')",
    "TRUNCATE shoplite.orders",
    "DROP TABLE shoplite.orders",
    "UPDATE shoplite.products SET name = 'x' WHERE sku = 'a'; DELETE FROM shoplite.orders WHERE true",
  ])("rejects anything but a single UPDATE or DELETE: %s", (sql) => {
    expect(checkDataFixSql(sql).ok).toBe(false);
  });

  it("rejects tables outside the shoplite schema", () => {
    expect(checkDataFixSql("UPDATE portal.tickets SET status = 'x' WHERE id = 1").ok).toBe(false);
    expect(checkDataFixSql("UPDATE nothing SET a = 1 WHERE id = 1").ok).toBe(false);
  });

  it("applies the reporter scope to the WHERE clause of a customer Ticket", () => {
    const fix = `UPDATE cart_totals SET item_count = 0 WHERE cart_id IN (SELECT id FROM carts WHERE customer_id = '${ava}')`;
    expect(checkDataFixSql(fix, scoped).ok).toBe(true);
    expect(
      checkDataFixSql("UPDATE cart_totals SET item_count = 0 WHERE cart_id = 'c1'", scoped).ok,
    ).toBe(false);
  });
});
