import { sql } from "drizzle-orm";
import {
  bigserial,
  check,
  index,
  integer,
  jsonb,
  pgSchema,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

/**
 * One Postgres instance, three schemas. Tables are added by the issues that own them:
 * ShopLite's own migrations fill `shoplite`, portal-api fills `portal`, mcp-incidents fills `knowledge`.
 */
export const shoplite = pgSchema("shoplite");
export const portal = pgSchema("portal");
export const knowledge = pgSchema("knowledge");

/** Cohere embed-v4.0 through the LangChain wrapper returns its default 1536 dimensions. */
export const EMBEDDING_DIMENSIONS = 1536;

/** Triage's Category vocabulary, see CONTEXT.md. An Incident records which kind of problem it was. */
export const incidentCategories = [
  "question",
  "user_error",
  "data_issue",
  "code_bug",
  "infra",
  "unknown",
] as const;
export type IncidentCategory = (typeof incidentCategories)[number];

/** Where a Ticket came from, see CONTEXT.md. Lives here because `tickets.source` is this enum. */
export const ticketSources = ["customer", "tester", "sentinel"] as const;
export type TicketSource = (typeof ticketSources)[number];

/** How a Ticket ended, see CONTEXT.md. Lives here because `tickets.outcome` is this enum. */
export const outcomes = ["answered", "data_fixed", "fix_proposed", "escalated"] as const;
export type Outcome = (typeof outcomes)[number];

/**
 * The Ticket lifecycle from PLAN.md section 4. Every Ticket starts `new` and ends `closed`;
 * `closed` is the only terminal status and always carries exactly one Outcome and one Reply.
 */
export const ticketStatuses = [
  "new",
  "triaging",
  "investigating",
  "awaiting_approval",
  "acting",
  "closed",
] as const;
export type TicketStatus = (typeof ticketStatuses)[number];

/**
 * What a timeline entry records. `status` is the portal's own: it writes one whenever the
 * lifecycle moves, and `decision` records a Reviewer's answer to an interrupt. The rest
 * come from the Resolver's stream, ending with the `verdict` the Ticket is closed from.
 */
export const ticketEventTypes = [
  "status",
  "subagent_start",
  "subagent_end",
  "tool_call",
  "tool_result",
  "message",
  "interrupt",
  "decision",
  "verdict",
] as const;
export type TicketEventType = (typeof ticketEventTypes)[number];

/** The Reviewer's verdict on a Proposal, see CONTEXT.md. */
export const decisions = ["approve", "edit", "reject"] as const;
export type Decision = (typeof decisions)[number];

/**
 * Who resolved a Ticket, and so who wrote the Incident it left behind. A Ticket the Resolver
 * finished is resolved by the agent; an escalated one is resolved by the human who closes it
 * through the manual resolution form, and stays unresolved until they do.
 */
export const resolvedByValues = ["agent", "human"] as const;
export type ResolvedBy = (typeof resolvedByValues)[number];

export const incidentCategory = knowledge.enum("incident_category", incidentCategories);
export const incidentResolvedBy = knowledge.enum("incident_resolved_by", resolvedByValues);

/**
 * The distilled record of a closed Ticket: symptoms, root cause, and what fixed it.
 * Written at ticket close for both agent-resolved and human-resolved Tickets.
 */
export const incidents = knowledge.table(
  "incidents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    symptoms: text("symptoms").notNull(),
    rootCause: text("root_cause").notNull(),
    resolution: text("resolution").notNull(),
    category: incidentCategory("category").notNull(),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }).notNull(),
    /** The portal Ticket this Incident was distilled from, when there was one. */
    sourceTicketId: uuid("source_ticket_id"),
    resolvedBy: incidentResolvedBy("resolved_by").notNull(),
    /** Who wrote the record: a person's name, or the Resolver. */
    author: text("author").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("incidents_embedding_idx").using("hnsw", table.embedding.op("vector_cosine_ops")),
  ],
);

/** Product guidance written ahead of time that answers a Question. Seeded, never written by the agent. */
export const helpArticles = knowledge.table(
  "help_articles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }).notNull(),
  },
  (table) => [
    index("help_articles_embedding_idx").using("hnsw", table.embedding.op("vector_cosine_ops")),
  ],
);

// The `portal` schema: Tickets, their timeline, and the approval gate. portal-api owns it.

export const ticketSource = portal.enum("ticket_source", ticketSources);
export const ticketStatus = portal.enum("ticket_status", ticketStatuses);
export const ticketOutcome = portal.enum("ticket_outcome", outcomes);
export const ticketEventType = portal.enum("ticket_event_type", ticketEventTypes);
export const approvalDecision = portal.enum("approval_decision", decisions);
export const ticketResolvedBy = portal.enum("ticket_resolved_by", resolvedByValues);

/**
 * A request for investigation, whatever its Source. The columns after `status` are filled
 * from the Verdict when the run closes the Ticket; the check keeps `closed` and the Outcome
 * and Reply that define it inseparable, so no Ticket can end without exactly one of each.
 * `category` reuses the Category vocabulary from CONTEXT.md, whose Postgres type was first
 * needed by Incidents.
 */
export const tickets = portal.table(
  "tickets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source: ticketSource("source").notNull(),
    /** The Reporter's email for customer Tickets: scopes database queries and redaction. */
    reporterEmail: text("reporter_email"),
    /** The ShopLite trace id from the storefront's error toast, when the Reporter had one. */
    traceId: text("trace_id"),
    /**
     * The Langfuse trace of the run that is investigating this Ticket, reported by the
     * Resolver when it starts. Rewritten by each run, so it always points at the latest.
     */
    langfuseTraceId: text("langfuse_trace_id"),
    /**
     * What Sentinel saw, as a route and an error type. It is Sentinel's own key for the
     * problem rather than for this Ticket, so a second detection of the same problem finds
     * the Ticket already open instead of filing another. Null on customer and tester Tickets.
     */
    fingerprint: text("fingerprint"),
    title: text("title").notNull(),
    body: text("body").notNull(),
    status: ticketStatus("status").notNull().default("new"),
    category: incidentCategory("category"),
    confidence: real("confidence"),
    outcome: ticketOutcome("outcome"),
    reply: text("reply"),
    rootCause: text("root_cause"),
    /**
     * What settled the Ticket: derived from the Verdict when the Resolver closed it, written
     * by the Reviewer when a person did. It is the Incident's resolution, kept on the Ticket
     * so the portal can show it without reading the knowledge base.
     */
    resolution: text("resolution"),
    /** Who resolved it. Null on an escalated Ticket no person has picked up yet. */
    resolvedBy: ticketResolvedBy("resolved_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "tickets_closed_carries_outcome_and_reply",
      sql`(${table.status} = 'closed') = (${table.outcome} IS NOT NULL AND ${table.reply} IS NOT NULL)`,
    ),
    check(
      "tickets_resolved_only_when_closed",
      sql`${table.resolvedBy} IS NULL OR ${table.status} = 'closed'`,
    ),
    check(
      "tickets_customer_has_reporter_email",
      sql`${table.source} <> 'customer' OR ${table.reporterEmail} IS NOT NULL`,
    ),
    index("tickets_reporter_email_idx").on(table.reporterEmail),
    // At most one open Ticket per fingerprint. The portal turns a second detection into the
    // Ticket already open, and this is what makes that true even if two arrive at once.
    uniqueIndex("tickets_open_fingerprint_idx")
      .on(table.fingerprint)
      .where(sql`${table.status} <> 'closed'`),
  ],
);

/**
 * One entry in a Ticket's live timeline, written as the Resolver streams. `id` is the
 * sequence the SSE stream sends as its event id, so a reconnecting client asks for
 * everything after the last one it saw. `run` counts re-runs of the same Ticket from 1.
 */
export const ticketEvents = portal.table(
  "ticket_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    run: integer("run").notNull(),
    type: ticketEventType("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("ticket_events_ticket_id_id_idx").on(table.ticketId, table.id)],
);

/** A Proposal waiting on a Reviewer, and what they decided. The portal executes it, never the agent. */
export const approvals = portal.table(
  "approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    /** Which run of the Ticket is paused on this Proposal, counting from 1. */
    run: integer("run").notNull().default(1),
    /** The interrupted tool call the Proposal came from, for example `apply_data_fix`. */
    action: text("action").notNull(),
    proposal: jsonb("proposal").$type<Record<string, unknown>>().notNull(),
    /**
     * What the Proposal would touch, read before the Reviewer sees it: the rows a data fix
     * matches today. Shown on the approval card so a Decision is made against the data.
     */
    preview: jsonb("preview").$type<Record<string, unknown>>(),
    decision: approvalDecision("decision"),
    /** The Proposal as the Reviewer edited it, when the Decision was `edit`. */
    editedProposal: jsonb("edited_proposal").$type<Record<string, unknown>>(),
    /** Why the Reviewer rejected it. The agent is told this and decides what to do instead. */
    reason: text("reason"),
    /** The rows a data fix touched, as they were before it ran, so it can be rolled back. */
    snapshot: jsonb("snapshot"),
    /** What running it did: the statement, the table, and the rows it changed. */
    result: jsonb("result").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    executedAt: timestamp("executed_at", { withTimezone: true }),
  },
  (table) => [index("approvals_ticket_id_idx").on(table.ticketId, table.createdAt)],
);
