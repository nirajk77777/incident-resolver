import { type Db, helpArticles, incidents } from "@incident-resolver/shared/db";
import { cosineDistance, eq, getTableColumns, sql } from "drizzle-orm";
import type { Candidate } from "./retrieval";

/** An Incident row without its embedding, which never leaves the store. */
export type IncidentRecord = Omit<typeof incidents.$inferSelect, "embedding">;

/** What `save_incident` and the seed provide; id and createdAt default in Postgres. */
export type NewIncident = Omit<IncidentRecord, "id" | "createdAt" | "sourceTicketId"> & {
  id?: string;
  createdAt?: Date;
  sourceTicketId?: string | null;
};

/** A Help article row without its embedding. */
export type HelpArticleRecord = Omit<typeof helpArticles.$inferSelect, "embedding">;

export type NewHelpArticle = Omit<HelpArticleRecord, "id"> & { id?: string };

const { embedding: _incidentEmbedding, ...incidentColumns } = getTableColumns(incidents);
const { embedding: _helpArticleEmbedding, ...helpArticleColumns } = getTableColumns(helpArticles);

/** The `knowledge` schema: Incidents and Help articles with their pgvector embeddings. */
export type KnowledgeStore = {
  /** The `limit` Incidents nearest to `embedding` by cosine similarity, nearest first. */
  nearestIncidents(embedding: number[], limit: number): Promise<Candidate<IncidentRecord>[]>;
  getIncident(id: string): Promise<IncidentRecord | null>;
  insertIncident(incident: NewIncident, embedding: number[]): Promise<IncidentRecord>;
  /**
   * Removes whatever a Ticket has already written here, so re-running it leaves one Incident
   * rather than one per run, and answers how many it removed.
   */
  deleteIncidentsForTicket(sourceTicketId: string): Promise<number>;
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

    async deleteIncidentsForTicket(sourceTicketId) {
      const removed = await db
        .delete(incidents)
        .where(eq(incidents.sourceTicketId, sourceTicketId))
        .returning({ id: incidents.id });
      return removed.length;
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
