import type { Pool } from "pg";
import { z } from "zod";

/** The customer a Ticket came from. Scopes every query and keeps their own email visible. */
export type Reporter = { customerId: string; email: string };

export type ReporterHint = {
  customerId?: string | undefined;
  email?: string | undefined;
};

/**
 * Resolves the reporter from a customer id or an email, whichever the caller has, against
 * ShopLite's customers table. Returns undefined when neither is given (tester and Sentinel
 * Tickets). Throws when a customer is named but does not exist, so a customer Ticket never
 * silently runs unscoped.
 */
export async function resolveReporter(
  pool: Pool,
  hint: ReporterHint,
): Promise<Reporter | undefined> {
  if (!hint.customerId && !hint.email) return undefined;

  let where: string;
  let value: string;
  if (hint.customerId) {
    const id = z.uuid().safeParse(hint.customerId);
    if (!id.success) throw new Error(`Reporter customer id is not a uuid: ${hint.customerId}`);
    where = "id = $1::uuid";
    value = id.data;
  } else {
    where = "lower(email) = lower($1)";
    value = hint.email as string;
  }

  const { rows } = await pool.query<{ id: string; email: string }>(
    `SELECT id, email FROM shoplite.customers WHERE ${where}`,
    [value],
  );
  const [row] = rows;
  if (!row) throw new Error(`No ShopLite customer matches the reporter ${value}`);
  return { customerId: row.id, email: row.email };
}
