import {
  type Expr,
  type From,
  parse,
  type QNameAliased,
  type SelectStatement,
  type Statement,
  toSql,
} from "pgsql-ast-parser";

/**
 * Static checks on SQL before it reaches Postgres.
 *
 * The read-only role is the real guard against writes. This module gives the agent a
 * clear reason instead of a permission error, and enforces the one rule the role cannot:
 * a customer Ticket only reads that customer's rows.
 *
 * Tenant scoping is a filter check, not a proof of isolation. Every SELECT that reads a
 * customer-owned table must carry `customer_id = '<reporter>'` (or `id = '<reporter>'` on
 * customers) as a top-level AND condition, directly or through an IN or EXISTS subquery that
 * carries it. Join graphs are not analysed, so a deliberate cross join could still widen a
 * result; a row-level security policy on the reader role is the next hardening step.
 */

export type TenantScope = { reporterCustomerId: string };

export type Rejected = { ok: false; reason: string };
export type ReadonlySqlCheck = { ok: true; sql: string } | Rejected;
export type DataFixSqlCheck =
  | { ok: true; statement: "update" | "delete"; table: string; where: string }
  | Rejected;

const SHOPLITE = "shoplite";
/** Tables whose rows belong to one customer, directly or through their cart. */
const tenantTables = new Set([
  "customers",
  "carts",
  "cart_items",
  "cart_totals",
  "orders",
  "payments",
]);
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
    const violation =
      nestedViolation(statement, scope, new Map()) ??
      (tenantTables.has(table) && !hasScopeFilter(statement.where, scope, new Map(), new Map())
        ? unscopedReason([table], scope)
        : undefined);
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
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `Could not parse the SQL. ${message.split("\n")[0]}` };
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
  const known = tenantTables.has(name.name) || publicTables.has(name.name);
  return inShoplite && known ? name.name : undefined;
}

function qualified(name: QNameAliased): string {
  return name.schema ? `${name.schema}.${name.name}` : name.name;
}

/** CTE name to whether that CTE already carries the reporter filter. */
type Ctes = Map<string, boolean>;

/**
 * Returns why `statement` breaks the reporter scope, or undefined if it respects it.
 * `ctes` are derived tables already checked where they were defined.
 */
function scopeViolation(statement: Statement, scope: TenantScope, ctes: Ctes): string | undefined {
  switch (statement.type) {
    case "select":
      return selectViolation(statement, scope, ctes);
    case "union":
    case "union all":
      return (
        scopeViolation(statement.left, scope, ctes) ?? scopeViolation(statement.right, scope, ctes)
      );
    case "with": {
      const inner = new Map(ctes);
      for (const bind of statement.bind) {
        const violation = scopeViolation(bind.statement, scope, inner);
        if (violation) return violation;
        inner.set(
          bind.alias.name,
          isSelect(bind.statement) && selectHasScopeFilter(bind.statement, scope, inner),
        );
      }
      return scopeViolation(statement.in, scope, inner);
    }
    case "with recursive": {
      const inner = new Map(ctes).set(statement.alias.name, false);
      return (
        scopeViolation(statement.bind, scope, inner) ?? scopeViolation(statement.in, scope, inner)
      );
    }
    default:
      return nestedViolation(statement, scope, ctes);
  }
}

function selectViolation(
  select: Extract<Statement, { type: "select" }>,
  scope: TenantScope,
  ctes: Ctes,
): string | undefined {
  const aliases = new Map<string, string>();
  const unscoped: string[] = [];

  for (const source of select.from ?? []) {
    if (source.type === "statement") {
      const violation = scopeViolation(source.statement, scope, ctes);
      if (violation) return violation;
      continue;
    }
    if (source.type !== "table") continue;
    if (source.name.schema === undefined && ctes.has(source.name.name)) continue;

    const table = shopliteTable(source.name);
    if (!table) {
      return (
        `Only ShopLite tables can be read for a customer Ticket, not ${qualified(source.name)}. ` +
        "Use describe_schema for table and column metadata."
      );
    }
    aliases.set(source.name.alias ?? table, table);
    if (tenantTables.has(table)) unscoped.push(table);
  }

  if (unscoped.length > 0 && !hasScopeFilter(select.where, scope, aliases, ctes)) {
    return unscopedReason(unscoped, scope);
  }
  return nestedViolation(select, scope, ctes, select.from ?? []);
}

function unscopedReason(tables: string[], scope: TenantScope): string {
  const id = scope.reporterCustomerId;
  return (
    "This is a customer Ticket, so every SELECT that reads a customer-owned table " +
    `(${[...tenantTables].join(", ")}) must filter by the reporter. Add customer_id = '${id}' ` +
    `as an AND condition (id = '${id}' on customers), or filter through ` +
    `IN (SELECT id FROM carts WHERE customer_id = '${id}'). Unfiltered here: ${tables.join(", ")}.`
  );
}

/**
 * True if one top-level AND condition of `where` pins the reporter: `customer_id = '<id>'`,
 * `id = '<id>'` on customers, or an IN / EXISTS subquery that itself carries the filter.
 */
function hasScopeFilter(
  where: Expr | null | undefined,
  scope: TenantScope,
  aliases: Map<string, string>,
  ctes: Ctes,
): boolean {
  return conjuncts(where).some((condition) => {
    if (condition.type === "binary" && condition.op === "=") {
      return (
        pinsReporter(condition.left, condition.right, scope, aliases) ||
        pinsReporter(condition.right, condition.left, scope, aliases)
      );
    }
    if (condition.type === "binary" && condition.op === "IN") {
      return isSelect(condition.right) && selectHasScopeFilter(condition.right, scope, ctes);
    }
    if (condition.type === "call" && condition.function.name.toLowerCase() === "exists") {
      const [subquery] = condition.args;
      return (
        subquery !== undefined && isSelect(subquery) && selectHasScopeFilter(subquery, scope, ctes)
      );
    }
    return false;
  });
}

/** A SELECT carries the filter if its WHERE has it, or if it reads a CTE that carries it. */
function selectHasScopeFilter(statement: SelectStatement, scope: TenantScope, ctes: Ctes): boolean {
  switch (statement.type) {
    case "select": {
      const from = statement.from ?? [];
      const readsScopedCte = from.some(
        (source) =>
          source.type === "table" &&
          source.name.schema === undefined &&
          ctes.get(source.name.name) === true,
      );
      return readsScopedCte || hasScopeFilter(statement.where, scope, aliasesOf(from), ctes);
    }
    case "union":
    case "union all":
      return (
        selectHasScopeFilter(statement.left, scope, ctes) &&
        selectHasScopeFilter(statement.right, scope, ctes)
      );
    case "with": {
      const inner = new Map(ctes);
      for (const bind of statement.bind) {
        inner.set(
          bind.alias.name,
          isSelect(bind.statement) && selectHasScopeFilter(bind.statement, scope, inner),
        );
      }
      return isSelect(statement.in) && selectHasScopeFilter(statement.in, scope, inner);
    }
    case "with recursive":
      return isSelect(statement.in) && selectHasScopeFilter(statement.in, scope, ctes);
    default:
      return false;
  }
}

function pinsReporter(
  column: Expr,
  value: Expr,
  scope: TenantScope,
  aliases: Map<string, string>,
): boolean {
  if (column.type !== "ref") return false;
  const literal = stringValue(value);
  if (literal === undefined || literal.toLowerCase() !== scope.reporterCustomerId.toLowerCase()) {
    return false;
  }
  if (column.name === "customer_id") return true;
  if (column.name !== "id") return false;
  if (column.table) return aliases.get(column.table.name) === "customers";
  return aliases.size === 1 && [...aliases.values()][0] === "customers";
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

function aliasesOf(from: From[]): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const source of from) {
    if (source.type !== "table") continue;
    const table = shopliteTable(source.name);
    if (table) aliases.set(source.name.alias ?? table, table);
  }
  return aliases;
}

const selectTypes = new Set(["select", "union", "union all", "with", "with recursive"]);

function isSelect(expr: unknown): expr is SelectStatement {
  return (
    typeof expr === "object" &&
    expr !== null &&
    "type" in expr &&
    typeof expr.type === "string" &&
    selectTypes.has(expr.type)
  );
}

/**
 * Checks every SELECT nested anywhere inside `node` (scalar subqueries, IN lists, SET
 * values), skipping the FROM sources the caller has already walked.
 */
function nestedViolation(
  node: object,
  scope: TenantScope,
  ctes: Ctes,
  skip: readonly unknown[] = [],
): string | undefined {
  for (const [key, value] of Object.entries(node)) {
    if (key === "_location" || skip.includes(value)) continue;
    const violation = violationIn(value, scope, ctes, skip);
    if (violation) return violation;
  }
  return undefined;
}

function violationIn(
  value: unknown,
  scope: TenantScope,
  ctes: Ctes,
  skip: readonly unknown[],
): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (skip.includes(item)) continue;
      const violation = violationIn(item, scope, ctes, skip);
      if (violation) return violation;
    }
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  if (isSelect(value)) return scopeViolation(value, scope, ctes);
  return nestedViolation(value, scope, ctes, skip);
}
