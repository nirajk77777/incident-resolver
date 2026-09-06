import {
  type Db,
  helpArticles,
  type IncidentCategory,
  incidents,
} from "@incident-resolver/shared/db";
import { cosineDistance, eq, sql } from "drizzle-orm";
import type { Candidate } from "./retrieval";

export type IncidentRecord = {
  id: string;
  title: string;
  symptoms: string;
  rootCause: string;
  resolution: string;
  category: IncidentCategory;
  sourceTicketId: string | null;
  resolvedBy: "agent" | "human";
  author: string;
  createdAt: Date;
};

/** What `save_incident` and the seed provide; id and createdAt default in Postgres. */
export type NewIncident = Omit<IncidentRecord, "id" | "createdAt" | "sourceTicketId"> & {
  id?: string;
  createdAt?: Date;
  sourceTicketId?: string | null;
};

export type HelpArticleRecord = {
  id: string;
  title: string;
  body: string;
  tags: string[];
};

export type NewHelpArticle = Omit<HelpArticleRecord, "id"> & { id?: string };

const incidentColumns = {
  id: incidents.id,
  title: incidents.title,
  symptoms: incidents.symptoms,
  rootCause: incidents.rootCause,
  resolution: incidents.resolution,
  category: incidents.category,
  sourceTicketId: incidents.sourceTicketId,
  resolvedBy: incidents.resolvedBy,
  author: incidents.author,
  createdAt: incidents.createdAt,
};

const helpArticleColumns = {
  id: helpArticles.id,
  title: helpArticles.title,
  body: helpArticles.body,
  tags: helpArticles.tags,
};

/** The `knowledge` schema: Incidents and Help articles with their pgvector embeddings. */
export type KnowledgeStore = {
  /** The `limit` Incidents nearest to `embedding` by cosine similarity, nearest first. */
  nearestIncidents(embedding: number[], limit: number): Promise<Candidate<IncidentRecord>[]>;
  getIncident(id: string): Promise<IncidentRecord | null>;
  insertIncident(incident: NewIncident, embedding: number[]): Promise<IncidentRecord>;
  nearestHelpArticles(embedding: number[], limit: number): Promise<Candidate<HelpArticleRecord>[]>;
  insertHelpArticle(article: NewHelpArticle, embedding: number[]): Promise<HelpArticleRecord>;
  /** Empties both tables. Used by the seed. */
  clear(): Promise<void>;
};

export function createKnowledgeStore(db: Db): KnowledgeStore {
  return {
    async nearestIncidents(embedding, limit) {
      const distance = cosineDistance(incidents.embedding, embedding);
      const rows = await db
        .select({ ...incidentColumns, similarity: sql<number>`1 - (${distance})` })
        .from(incidents)
        .orderBy(distance)
        .limit(limit);
      return rows.map(({ similarity, ...item }) => ({ item, similarity }));
    },

    async getIncident(id) {
      const [row] = await db.select(incidentColumns).from(incidents).where(eq(incidents.id, id));
      return row ?? null;
    },

    async insertIncident(incident, embedding) {
      const [row] = await db
        .insert(incidents)
        .values({ ...incident, embedding })
        .returning(incidentColumns);
      if (!row) throw new Error("Insert returned no row");
      return row;
    },

    async nearestHelpArticles(embedding, limit) {
      const distance = cosineDistance(helpArticles.embedding, embedding);
      const rows = await db
        .select({ ...helpArticleColumns, similarity: sql<number>`1 - (${distance})` })
        .from(helpArticles)
        .orderBy(distance)
        .limit(limit);
      return rows.map(({ similarity, ...item }) => ({ item, similarity }));
    },

    async insertHelpArticle(article, embedding) {
      const [row] = await db
        .insert(helpArticles)
        .values({ ...article, embedding })
        .returning(helpArticleColumns);
      if (!row) throw new Error("Insert returned no row");
      return row;
    },

    async clear() {
      await db.delete(incidents);
      await db.delete(helpArticles);
    },
  };
}
