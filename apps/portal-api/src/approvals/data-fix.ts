import { checkDataFixSql } from "@incident-resolver/mcp-database";
import { messageOf } from "@incident-resolver/shared";
import { Pool } from "pg";
import { parse } from "pgsql-ast-parser";

/**
 * Running an approved data fix. This is the only place in the system that writes ShopLite
 * data, and it is deliberately narrow: the statement is parsed and must be one UPDATE or
 * DELETE with a WHERE clause on a ShopLite table, the rows it matches are counted against the
 * cap and snapshotted for rollback, and the write happens inside one transaction as a role
 * that has no other privilege. PLAN.md section 5.
 */

export type FixRefused = { ok: false; reason: string };

export type FixStatement = {
  ok: true;
  statement: "update" | "delete";
  table: string;
  where: string;
};

/** The rows a fix matches, read before it runs: the approval card's preview and its snapshot. */
export type FixRows = {
  ok: true;
  table: string;
  statement: "update" | "delete";
  rows: Row[];
  rowCount: number;
};

/** What running an approved fix did. */
export type FixApplied = {
  ok: true;
  statement: "update" | "delete";
  table: string;
  /** Rows the statement changed. */
  rowCount: number;
  /** Those rows as they were before it ran, so the fix can be undone by hand. */
  snapshot: Row[];
};

type Row = Record<string, unknown>;

/**
 * The static half of the guard, which needs no database: one UPDATE or DELETE with a WHERE
 * clause on a ShopLite table. Shared with mcp-database, so the Proposal the agent made and
 * the statement the portal runs are held to the same rule even after a Reviewer edits it.
 *
 * One rule is the portal's own. A statement that reads a second table — `UPDATE t SET … FROM
 * u WHERE …` — is refused, because the rows it matches cannot then be read back by table and
 * WHERE alone, and a fix whose rows cannot be shown to a Reviewer or kept for rollback is not
 * one this portal will run.
 */
export function checkFix(sql: string): FixStatement | FixRefused {
  const check = checkDataFixSql(sql);
  if (!check.ok) return check;
  if (readsAnotherTable(sql)) {
    return {
      ok: false,
      reason:
        "A data fix must stand on its own table: an UPDATE ... FROM cannot be previewed or " +
        "kept for rollback. Put what the other table gives you into the SET and WHERE as values.",
    };
  }
  return { ok: true, statement: check.statement, table: check.table, where: check.where };
}

/** Whether an UPDATE pulls in a second table through a FROM clause. */
function readsAnotherTable(sql: string): boolean {
  const [statement] = parse(sql);
  return statement?.type === "update" && statement.from !== undefined && statement.from !== null;
}

/** Why a fix that matches this many rows must not run, or undefined when it may. */
export function overRowCap(rows: number, cap: number): string | undefined {
  if (rows <= cap) return undefined;
  return `The fix matches ${rows} rows, over the cap of ${cap}. Narrow the WHERE clause.`;
}

export type DataFixRunnerOptions = {
  /** Connects as the UPDATE/DELETE-only ShopLite role, see migration 0007. */
  databaseUrl: string;
  /** An approved fix that would touch more rows than this is refused. */
  rowCap: number;
};

export type DataFixRunner = {
  /** The rows the fix matches today, for the card the Reviewer decides against. */
  preview(sql: string): Promise<FixRows | FixRefused>;
  /** Snapshots and runs the fix in one transaction. Nothing else in the portal writes ShopLite. */
  apply(sql: string): Promise<FixApplied | FixRefused>;
  close(): Promise<void>;
};

export function createDataFixRunner({ databaseUrl, rowCap }: DataFixRunnerOptions): DataFixRunner {
  // Opened on the first fix rather than at startup: a portal that never approves one never
  // connects as the writing role at all.
  let pool: Pool | undefined;
  const open = () => (pool ??= new Pool({ connectionString: databaseUrl, max: 2 }));

  return {
    async preview(sql) {
      const check = checkFix(sql);
      if (!check.ok) return check;
      try {
        const { rows } = await open().query<Row>(matching(check));
        return {
          ok: true,
          table: check.table,
          statement: check.statement,
          rows,
          rowCount: rows.length,
        };
      } catch (error) {
        return {
          ok: false,
          reason: `Could not read the rows the fix matches: ${messageOf(error)}`,
        };
      }
    },

    async apply(sql) {
      const check = checkFix(sql);
      if (!check.ok) return check;
      const client = await open().connect();
      try {
        await client.query("BEGIN");
        // Inside the transaction, so the rows kept for rollback are the ones the statement
        // then changes rather than whatever they were a moment before it.
        const before = await client.query<Row>(matching(check));
        const capped = overRowCap(before.rows.length, rowCap);
        if (capped) {
          await client.query("ROLLBACK");
          return { ok: false, reason: capped };
        }
        const result = await client.query(sql);
        const changed = result.rowCount ?? 0;
        // The count is checked again against what actually changed: a WHERE the count query
        // and the statement read differently is a reason to run neither.
        const wide = overRowCap(changed, rowCap);
        if (wide) {
          await client.query("ROLLBACK");
          return { ok: false, reason: wide };
        }
        await client.query("COMMIT");
        return {
          ok: true,
          statement: check.statement,
          table: check.table,
          rowCount: changed,
          snapshot: before.rows,
        };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        return { ok: false, reason: `The fix failed and nothing was changed: ${messageOf(error)}` };
      } finally {
        client.release();
      }
    },

    async close() {
      await pool?.end();
      pool = undefined;
    },
  };
}

/**
 * The rows a fix matches. Built from the parsed WHERE clause rather than the text, so it is
 * the same condition the statement itself will apply.
 */
function matching(check: FixStatement): string {
  return `SELECT * FROM ${check.table} WHERE ${check.where}`;
}
