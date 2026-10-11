import { describe, expect, it } from "vitest";
import { checkFix, overRowCap } from "./data-fix";

describe("what the portal will run", () => {
  it("accepts an UPDATE with a WHERE clause on a ShopLite table", () => {
    const check = checkFix(
      "UPDATE shoplite.cart_totals SET total_cents = 1200 WHERE cart_id = '8ee0b3f6-0b6d-4a2c-9a4e-6d1b7e2c0a11'",
    );
    expect(check).toMatchObject({ ok: true, statement: "update", table: "shoplite.cart_totals" });
  });

  it("refuses an UPDATE with no WHERE clause, which would touch every row", () => {
    const check = checkFix("UPDATE shoplite.cart_totals SET total_cents = 0");
    expect(check).toMatchObject({ ok: false });
    if (!check.ok) expect(check.reason).toMatch(/WHERE/);
  });

  it("refuses anything that is not an UPDATE or a DELETE", () => {
    for (const sql of [
      "SELECT * FROM shoplite.cart_totals",
      "INSERT INTO shoplite.cart_totals (cart_id) VALUES ('x')",
      "DROP TABLE shoplite.cart_totals",
      "TRUNCATE shoplite.cart_totals",
    ]) {
      expect(checkFix(sql).ok).toBe(false);
    }
  });

  it("refuses a statement outside the ShopLite schema", () => {
    expect(checkFix("DELETE FROM portal.tickets WHERE id = '1'").ok).toBe(false);
  });

  it("refuses an UPDATE that reads a second table, whose rows it could not keep", () => {
    const check = checkFix(
      "UPDATE shoplite.cart_totals SET item_count = c.n FROM counts c WHERE c.cart_id = shoplite.cart_totals.cart_id",
    );
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toMatch(/rollback|previewed/);
  });

  it("refuses two statements sent as one, so nothing rides along behind the fix", () => {
    expect(
      checkFix(
        "UPDATE shoplite.cart_totals SET total_cents = 1 WHERE cart_id = '1'; DELETE FROM shoplite.orders WHERE id = '2'",
      ).ok,
    ).toBe(false);
  });
});

describe("the row cap", () => {
  it("passes a fix that stays under it", () => {
    expect(overRowCap(3, 100)).toBeUndefined();
    expect(overRowCap(100, 100)).toBeUndefined();
  });

  it("refuses one that would touch more rows than the cap, saying both numbers", () => {
    const reason = overRowCap(101, 100);
    expect(reason).toMatch(/101/);
    expect(reason).toMatch(/100/);
  });
});
