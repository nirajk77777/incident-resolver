import { messageOf } from "@incident-resolver/shared";
import {
  type DeleteStatement,
  type Expr,
  type ExprRef,
  type From,
  parse,
  type QNameAliased,
  type SelectStatement,
  type Statement,
  toSql,
  type UpdateStatement,
} from "pgsql-ast-parser";

/**
 * Static checks on SQL before it reaches Postgres.
 *
 * The read-only role is the real guard against writes. This module gives the agent a
 * clear reason instead of a permission error, and enforces the one rule the role cannot:
 * a customer Ticket only reads that customer's rows.
 *
 * Tenant scoping works per table reference. A reference to a customer-owned table is
 * "pinned" when a top-level AND condition sets its customer_id (or id, on customers) to the
 * reporter, when its column is IN or EXISTS a subquery that is itself pinned, when it is a
 * CTE or derived table that is pinned, or when it is joined on id columns to a pinned
 * reference. Every customer-owned reference in a SELECT must end up pinned. This is a
 * filter check, not row-level security: a join on a non-id column is refused rather than
 * analysed, and a policy on the reader role remains the next hardening step.
 */

export type TenantScope = { reporterCustomerId: string };

export type Rejected = { ok: false; reason: string };
export type ReadonlySqlCheck = { ok: true; sql: string } | Rejected;
export type DataFixSqlCheck =
  | { ok: true; statement: "update" | "delete"; table: string; where: string }
  | Rejected;

const SHOPLITE = "shoplite";
/** Tables whose rows belong to one customer, directly or through their cart. */
export const tenantTables = [
  "customers",
  "carts",
  "cart_items",
  "cart_totals",
  "orders",
  "payments",
] as const;
/** The same list as prose, for tool descriptions and rejection messages. */
export const tenantTableList = `${tenantTables.slice(0, -1).join(", ")}, or ${tenantTables.at(-1)}`;
const tenantTableSet = new Set<string>(tenantTables);
const publicTables = new Set(["products", "discount_codes"]);

/** Accepts exactly one SELECT (CTEs and unions included) and applies the reporter scope. */
export function checkReadonlySql(sql: string, scope?: TenantScope): ReadonlySqlCheck {
  const parsed = parseSingle(sql);
  if ("reason" in parsed) return { ok: false, reason: parsed.reason };

  if (!isReadOnly(parsed.statement)) {
    return {
      ok: false,
      reason:
        "Only a single SELECT is allowed here. Writes are never run by this tool; " +
        "propose one with propose_data_fix instead.",
    };
  }
  if (scope) {
    const violation = scopeViolation(parsed.statement, scope, new Map());
    if (violation) return { ok: false, reason: violation };
  }
  return { ok: true, sql: sql.trim().replace(/;\s*$/, "") };
}

/** Accepts exactly one UPDATE or DELETE on a ShopLite table with a WHERE clause. */
export function checkDataFixSql(sql: string, scope?: TenantScope): DataFixSqlCheck {
  const parsed = parseSingle(sql);
  if ("reason" in parsed) return { ok: false, reason: parsed.reason };
  const { statement } = parsed;

  if (statement.type !== "update" && statement.type !== "delete") {
    return {
      ok: false,
      reason: "A data fix must be a single UPDATE or DELETE statement with a WHERE clause.",
    };
  }
  const target = statement.type === "update" ? statement.table : statement.from;
  const table = shopliteTable(target);
  if (!table) {
    return {
      ok: false,
      reason: `A data fix can only target a ShopLite table (shoplite.*), not ${qualified(target)}.`,
    };
  }
  if (!statement.where) {
    return {
      ok: false,
      reason: "A data fix must have a WHERE clause so it cannot touch every row in the table.",
    };
  }
  if (scope) {
    const violation = dataFixViolation(statement, target, table, scope);
    if (violation) return { ok: false, reason: violation };
  }
  return {
    ok: true,
    statement: statement.type,
    table: `${SHOPLITE}.${table}`,
    where: toSql.expr(statement.where),
  };
}

function parseSingle(sql: string): { statement: Statement } | Rejected {
  let statements: Statement[];
  try {
    statements = parse(sql);
  } catch (error) {
    return { ok: false, reason: `Could not parse the SQL. ${messageOf(error).split("\n")[0]}` };
  }
  const [statement] = statements;
  if (!statement || statements.length !== 1) {
    return { ok: false, reason: `Send exactly one statement; got ${statements.length}.` };
  }
  return { statement };
}

function isReadOnly(statement: Statement): boolean {
  switch (statement.type) {
    case "select":
      return !statement.for;
    case "union":
    case "union all":
      return isReadOnly(statement.left) && isReadOnly(statement.right);
    case "with":
      return statement.bind.every((b) => isReadOnly(b.statement)) && isReadOnly(statement.in);
    case "with recursive":
      return isReadOnly(statement.bind) && isReadOnly(statement.in);
    default:
      return false;
  }
}

/** The bare table name if `name` is a ShopLite table, else undefined. */
function shopliteTable(name: QNameAliased): string | undefined {
  const inShoplite = name.schema === undefined || name.schema === SHOPLITE;
  const known = tenantTableSet.has(name.name) || publicTables.has(name.name);
  return inShoplite && known ? name.name : undefined;
}

function qualified(name: QNameAliased): string {
  return name.schema ? `${name.schema}.${name.name}` : name.name;
}

/** CTE name to whether that CTE is pinned to the reporter. */
type Ctes = Map<string, boolean>;

/** One entry of a FROM list: a table, a CTE, a derived table, or a set-returning call. */
type Source = {
  alias: string;
  /** Set for ShopLite tables only. */
  table: string | undefined;
  /** True for CTEs and derived tables that are already pinned to the reporter. */
  pinned: boolean;
};

type Analysis = {
  /** Aliases pinned to the reporter. Non-empty means the statement carries the filter. */
  pinned: Set<string>;
  violation: string | undefined;
};

/** Returns why `statement` breaks the reporter scope, or undefined if it respects it. */
function scopeViolation(statement: Statement, scope: TenantScope, ctes: Ctes): string | undefined {
  return isSelect(statement)
    ? analyseSelect(statement, scope, ctes).violation
    : nestedViolation(statement, scope, ctes, []);
}

function analyseSelect(statement: SelectStatement, scope: TenantScope, ctes: Ctes): Analysis {
  switch (statement.type) {
    case "select": {
      const sources = collectSources(statement.from ?? [], scope, ctes);
      if (sources.violation) return { pinned: new Set(), violation: sources.violation };
      const conditions = [...conjuncts(statement.where), ...sources.conditions];
      const pinned = resolvePinned(sources.sources, conditions, scope, ctes);
      const unpinned = sources.sources.filter(
        (source) => source.table && tenantTableSet.has(source.table) && !pinned.has(source.alias),
      );
      if (unpinned.length > 0) {
        return { pinned, violation: unscopedReason(unpinned.map(labelOf), scope) };
      }
      return { pinned, violation: nestedViolation(statement, scope, ctes, sources.derived) };
    }
    case "union":
    case "union all": {
      const left = analyseSelect(statement.left, scope, ctes);
      const right = analyseSelect(statement.right, scope, ctes);
      const both = left.pinned.size > 0 && right.pinned.size > 0;
      return {
        pinned: both ? new Set([...left.pinned, ...right.pinned]) : new Set(),
        violation: left.violation ?? right.violation,
      };
    }
    case "with": {
      const inner = new Map(ctes);
      for (const bind of statement.bind) {
        const analysis = analyseBinding(bind.statement, scope, inner);
        if (analysis.violation) return analysis;
        inner.set(bind.alias.name, analysis.pinned.size > 0);
      }
      return analyseBinding(statement.in, scope, inner);
    }
    case "with recursive": {
      const inner = new Map(ctes).set(statement.alias.name, false);
      const bind = analyseSelect(statement.bind, scope, inner);
      if (bind.violation) return bind;
      return analyseBinding(statement.in, scope, inner);
    }
    default:
      return { pinned: new Set(), violation: undefined };
  }
}

function analyseBinding(statement: Statement, scope: TenantScope, ctes: Ctes): Analysis {
  return isSelect(statement)
    ? analyseSelect(statement, scope, ctes)
    : { pinned: new Set(), violation: nestedViolation(statement, scope, ctes, []) };
}

function dataFixViolation(
  statement: UpdateStatement | DeleteStatement,
  target: QNameAliased,
  table: string,
  scope: TenantScope,
  ctes: Ctes = new Map(),
): string | undefined {
  const extra = statement.type === "update" && statement.from ? [statement.from] : [];
  const collected = collectSources(extra, scope, ctes);
  if (collected.violation) return collected.violation;

  const targetSource: Source = { alias: target.alias ?? table, table, pinned: false };
  const sources = [targetSource, ...collected.sources];
  const conditions = [...conjuncts(statement.where), ...collected.conditions];
  const pinned = resolvePinned(sources, conditions, scope, ctes);
  if (tenantTableSet.has(table) && !pinned.has(targetSource.alias)) {
    return unscopedReason([labelOf(targetSource)], scope);
  }
  return nestedViolation(statement, scope, ctes, collected.derived);
}

type CollectedSources = {
  sources: Source[];
  /** Conjuncts of every JOIN ... ON clause. */
  conditions: Expr[];
  /** Derived-table statements already analysed, so the nested walk skips them. */
  derived: SelectStatement[];
  violation?: string;
};

function collectSources(from: From[], scope: TenantScope, ctes: Ctes): CollectedSources {
  const collected: CollectedSources = { sources: [], conditions: [], derived: [] };
  for (const entry of from) {
    if (entry.join?.on) collected.conditions.push(...conjuncts(entry.join.on));
    switch (entry.type) {
      case "table": {
        const { name } = entry;
        if (name.schema === undefined && ctes.has(name.name)) {
          collected.sources.push({
            alias: name.alias ?? name.name,
            table: undefined,
            pinned: ctes.get(name.name) === true,
          });
          break;
        }
        const table = shopliteTable(name);
        if (!table) {
          return {
            ...collected,
            violation:
              `Only ShopLite tables can be read for a customer Ticket, not ${qualified(name)}. ` +
              "Use describe_schema for table and column metadata.",
          };
        }
        collected.sources.push({ alias: name.alias ?? table, table, pinned: false });
        break;
      }
      case "statement": {
        const inner = analyseSelect(entry.statement, scope, ctes);
        if (inner.violation) return { ...collected, violation: inner.violation };
        collected.sources.push({
          alias: entry.alias,
          table: undefined,
          pinned: inner.pinned.size > 0,
        });
        collected.derived.push(entry.statement);
        break;
      }
      case "call":
        collected.sources.push({
          alias: entry.alias?.name ?? entry.function.name,
          table: undefined,
          pinned: false,
        });
        break;
    }
  }
  return collected;
}

/**
 * Seeds the pinned set from conditions that name the reporter, then spreads it along
 * equalities between id columns until nothing changes.
 */
function resolvePinned(
  sources: Source[],
  conditions: Expr[],
  scope: TenantScope,
  ctes: Ctes,
): Set<string> {
  const pinned = new Set(sources.filter((s) => s.pinned).map((s) => s.alias));
  const [only] = sources;
  const aliasOf = (ref: ExprRef): string | undefined =>
    ref.table?.name ?? (sources.length === 1 ? only?.alias : undefined);
  const tableOf = (alias: string | undefined): string | undefined =>
    sources.find((s) => s.alias === alias)?.table;
  const carries = (subquery: SelectStatement): boolean => {
    const analysis = analyseSelect(subquery, scope, ctes);
    return analysis.violation === undefined && analysis.pinned.size > 0;
  };
  const pin = (ref: ExprRef | undefined) => {
    const alias = ref && aliasOf(ref);
    if (alias) pinned.add(alias);
  };
  const edges: Array<[string, string]> = [];

  for (const condition of conditions) {
    if (condition.type === "binary" && condition.op === "=") {
      const { left, right } = condition;
      if (left.type === "ref" && right.type === "ref") {
        const a = aliasOf(left);
        const b = aliasOf(right);
        if (a && b && isIdColumn(left.name) && isIdColumn(right.name)) edges.push([a, b]);
      } else {
        pin(
          pinsReporter(left, right, scope, aliasOf, tableOf) ??
            pinsReporter(right, left, scope, aliasOf, tableOf),
        );
      }
    } else if (condition.type === "binary" && condition.op === "IN") {
      if (condition.left.type === "ref" && isSelect(condition.right) && carries(condition.right)) {
        pin(condition.left);
      }
    } else if (condition.type === "call" && condition.function.name.toLowerCase() === "exists") {
      const [subquery] = condition.args;
      if (subquery && isSelect(subquery) && carries(subquery) && sources.length === 1) {
        pin({ type: "ref", name: "*" });
      }
    }
  }

  let grew = true;
  while (grew) {
    grew = false;
    for (const [a, b] of edges) {
      if (pinned.has(a) !== pinned.has(b)) {
        pinned.add(a).add(b);
        grew = true;
      }
    }
  }
  return pinned;
}

/** The column reference if `column = value` names the reporter, else undefined. */
function pinsReporter(
  column: Expr,
  value: Expr,
  scope: TenantScope,
  aliasOf: (ref: ExprRef) => string | undefined,
  tableOf: (alias: string | undefined) => string | undefined,
): ExprRef | undefined {
  if (column.type !== "ref") return undefined;
  const literal = stringValue(value);
  if (literal?.toLowerCase() !== scope.reporterCustomerId.toLowerCase()) return undefined;
  if (column.name === "customer_id") return column;
  if (column.name === "id" && tableOf(aliasOf(column)) === "customers") return column;
  return undefined;
}

function isIdColumn(name: string): boolean {
  return name === "id" || name.endsWith("_id");
}

function stringValue(expr: Expr): string | undefined {
  if (expr.type === "string") return expr.value;
  if (expr.type === "cast") return stringValue(expr.operand);
  return undefined;
}

function conjuncts(expr: Expr | null | undefined): Expr[] {
  if (!expr) return [];
  if (expr.type === "binary" && expr.op === "AND") {
    return [...conjuncts(expr.left), ...conjuncts(expr.right)];
  }
  return [expr];
}

function labelOf(source: Source): string {
  return source.alias === source.table ? source.alias : `${source.table} (${source.alias})`;
}

function unscopedReason(labels: string[], scope: TenantScope): string {
  const id = scope.reporterCustomerId;
  return (
    "This is a customer Ticket, so every table that belongs to a customer " +
    `(${tenantTableList}) must be filtered by the reporter. Add customer_id = '${id}' ` +
    `as an AND condition (id = '${id}' on customers), join the table on an id column to one ` +
    `that has that condition, or filter through IN (SELECT id FROM carts WHERE customer_id = '${id}'). ` +
    `Unfiltered here: ${labels.join(", ")}.`
  );
}

const selectTypes = new Set(["select", "union", "union all", "with", "with recursive"]);

function isSelect(node: unknown): node is SelectStatement {
  return (
    typeof node === "object" &&
    node !== null &&
    "type" in node &&
    typeof node.type === "string" &&
    selectTypes.has(node.type)
  );
}

/**
 * Checks every SELECT nested anywhere inside `node` (scalar subqueries, IN lists, SET
 * values, JOIN conditions), skipping derived tables the caller has already analysed.
 */
function nestedViolation(
  node: unknown,
  scope: TenantScope,
  ctes: Ctes,
  skip: readonly SelectStatement[],
): string | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  if (Array.isArray(node)) {
    for (const item of node) {
      const violation = nestedViolation(item, scope, ctes, skip);
      if (violation) return violation;
    }
    return undefined;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "_location" || skip.includes(value as SelectStatement)) continue;
    const violation = isSelect(value)
      ? scopeViolation(value, scope, ctes)
      : nestedViolation(value, scope, ctes, skip);
    if (violation) return violation;
  }
  return undefined;
}
