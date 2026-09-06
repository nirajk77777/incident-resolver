import { sql } from "drizzle-orm";
import { index, pgSchema, text, timestamp, uuid, vector } from "drizzle-orm/pg-core";

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

export const incidentCategory = knowledge.enum("incident_category", incidentCategories);
export const incidentResolvedBy = knowledge.enum("incident_resolved_by", ["agent", "human"]);

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
