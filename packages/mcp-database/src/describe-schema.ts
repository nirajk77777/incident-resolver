import type { Pool } from "pg";
import type { Reporter } from "./reporter";

export type ColumnInfo = {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
};

export type TableInfo = {
  name: string;
  columns: ColumnInfo[];
  /** Primary key, unique, and foreign key definitions as Postgres prints them. */
  constraints: string[];
};

/** Reads the `shoplite` schema's tables, columns, and constraints from the catalog. */
export async function describeSchema(pool: Pool): Promise<TableInfo[]> {
  const columns = await pool.query<{
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: "YES" | "NO";
    column_default: string | null;
  }>(
    `SELECT table_name, column_name, data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = 'shoplite' AND table_name <> '__drizzle_migrations'
     ORDER BY table_name, ordinal_position`,
  );
  const constraints = await pool.query<{ table_name: string; definition: string }>(
    `SELECT c.conrelid::regclass::text AS table_name, pg_get_constraintdef(c.oid) AS definition
     FROM pg_constraint c
     WHERE c.connamespace = 'shoplite'::regnamespace AND c.contype IN ('p', 'u', 'f')
     ORDER BY c.conrelid::regclass::text, c.contype, c.conname`,
  );

  const tables = new Map<string, TableInfo>();
  for (const row of columns.rows) {
    const table = tables.get(row.table_name) ?? {
      name: row.table_name,
      columns: [],
      constraints: [],
    };
    table.columns.push({
      name: row.column_name,
      type: row.data_type,
      nullable: row.is_nullable === "YES",
      default: row.column_default,
    });
    tables.set(row.table_name, table);
  }
  for (const row of constraints.rows) {
    tables.get(row.table_name.replace(/^shoplite\./, ""))?.constraints.push(row.definition);
  }
  return [...tables.values()];
}

/** Renders the schema as text an agent can read before writing SQL. */
export function formatSchema(tables: TableInfo[], reporter: Reporter | undefined): string {
  const lines = [
    "# ShopLite schema (`shoplite`, on the search path, so bare table names work)",
    "",
  ];
  if (reporter) {
    lines.push(
      `This is a customer Ticket for customer ${reporter.customerId} (${reporter.email}).`,
      "Every SELECT that reads customers, carts, cart_items, cart_totals, orders, or payments",
      `must filter by customer_id = '${reporter.customerId}' (id = '${reporter.customerId}' on customers).`,
      "cart_items and cart_totals belong to a customer through carts.customer_id.",
      "",
    );
  }
  for (const table of tables) {
    lines.push(`## ${table.name}`);
    for (const column of table.columns) {
      const parts = [column.type, column.nullable ? "null" : "not null"];
      if (column.default) parts.push(`default ${column.default}`);
      lines.push(`- ${column.name}: ${parts.join(", ")}`);
    }
    if (table.constraints.length > 0) lines.push(`Constraints: ${table.constraints.join("; ")}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
