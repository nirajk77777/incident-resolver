import { incidentCategories } from "@incident-resolver/shared/db";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { helpArticleDocument, incidentDocument } from "./documents";
import { messageOf } from "./errors";
import { type Embedder, type Ranked, type Reranker, searchRanked } from "./retrieval";
import type { HelpArticleRecord, IncidentRecord, KnowledgeStore } from "./store";

export type IncidentsServerOptions = {
  store: KnowledgeStore;
  embedder: Embedder;
  reranker: Reranker;
  /** Rows pulled from pgvector by cosine similarity before reranking. */
  candidates: number;
  /** Rows returned after reranking when the caller gives no `k`. */
  topK: number;
};

/** What `search_similar_incidents` returns. */
export type IncidentSearchResult = {
  query: string;
  results: Array<IncidentRecord & { similarity: number; relevanceScore: number }>;
};

/** What `search_help_articles` returns. */
export type HelpArticleSearchResult = {
  query: string;
  results: Array<HelpArticleRecord & { similarity: number; relevanceScore: number }>;
};

/** Builds the `mcp-incidents` server. Connect it to a transport to serve. */
export function createIncidentsServer(options: IncidentsServerOptions): McpServer {
  const { store, embedder, reranker, candidates, topK } = options;
  const server = new McpServer({ name: "mcp-incidents", version: "0.0.0" });

  const k = z
    .number()
    .int()
    .min(1)
    .max(candidates)
    .default(topK)
    .describe(`How many matches to return after reranking, ${topK} unless you need more`);

  server.registerTool(
    "search_similar_incidents",
    {
      title: "Search past Incidents",
      description:
        "Finds past Incidents whose symptoms match a description. Describe what is happening the way the " +
        `reporter did. The ${candidates} nearest by embedding are reranked and the best ${topK} come back ` +
        "with their documented root cause, resolution, and a relevance score from 0 to 1.",
      inputSchema: { text: z.string().min(1).describe("The symptoms to match"), k },
      annotations: { readOnlyHint: true },
    },
    async ({ text: query, k: limit }) => {
      try {
        const ranked = await searchRanked<IncidentRecord>({
          query,
          embedder,
          reranker,
          fetchCandidates: (embedding, n) => store.nearestIncidents(embedding, n),
          documentOf: incidentDocument,
          candidates,
          topK: limit,
        });
        const payload: IncidentSearchResult = { query, results: ranked.map(flatten) };
        return text(JSON.stringify(payload, null, 2));
      } catch (error) {
        return failure(`Search failed: ${messageOf(error)}`);
      }
    },
  );

  server.registerTool(
    "get_incident",
    {
      title: "Get one Incident",
      description:
        "The full record of one past Incident by id, as returned by search_similar_incidents.",
      inputSchema: { id: z.uuid().describe("The Incident id") },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const incident = await store.getIncident(id);
      return incident
        ? text(JSON.stringify(incident, null, 2))
        : failure(`No Incident with id ${id}`);
    },
  );

  server.registerTool(
    "save_incident",
    {
      title: "Save an Incident",
      description:
        "Writes the distilled record of a closed Ticket to the knowledge base so future searches find it: " +
        "what the reporter saw, what was actually wrong, and what fixed it. Call it once, at Ticket close.",
      inputSchema: {
        title: z.string().min(1).describe("One line naming the problem"),
        symptoms: z
          .string()
          .min(1)
          .describe("What the reporter saw, with the Evidence that confirmed it"),
        rootCause: z.string().min(1).describe("What was actually wrong"),
        resolution: z
          .string()
          .min(1)
          .describe("What fixed it: the SQL that was run, the code change, or the answer given"),
        category: z.enum(incidentCategories).describe("Triage's Category for the Ticket"),
        sourceTicketId: z.uuid().optional().describe("The portal Ticket id this came from"),
        resolvedBy: z.enum(["agent", "human"]).describe("Who resolved the Ticket"),
        author: z.string().min(1).describe("Who wrote this record: a person's name, or Resolver"),
      },
    },
    async ({ sourceTicketId, ...record }) => {
      try {
        const [embedding] = await embedder.embedDocuments([incidentDocument(record)]);
        if (!embedding) return failure("The embedder returned no vector");
        const saved = await store.insertIncident(
          { ...record, sourceTicketId: sourceTicketId ?? null },
          embedding,
        );
        return text(JSON.stringify(saved, null, 2));
      } catch (error) {
        return failure(`Save failed: ${messageOf(error)}`);
      }
    },
  );

  server.registerTool(
    "search_help_articles",
    {
      title: "Search Help articles",
      description:
        "Finds Help articles that answer a Question: how-to requests and known workarounds such as clearing " +
        `the cache. The ${candidates} nearest by embedding are reranked and the best ${topK} come back with a ` +
        "relevance score from 0 to 1. A high score means the Ticket can be answered without investigation.",
      inputSchema: { text: z.string().min(1).describe("The question or symptoms to match"), k },
      annotations: { readOnlyHint: true },
    },
    async ({ text: query, k: limit }) => {
      try {
        const ranked = await searchRanked<HelpArticleRecord>({
          query,
          embedder,
          reranker,
          fetchCandidates: (embedding, n) => store.nearestHelpArticles(embedding, n),
          documentOf: helpArticleDocument,
          candidates,
          topK: limit,
        });
        const payload: HelpArticleSearchResult = { query, results: ranked.map(flatten) };
        return text(JSON.stringify(payload, null, 2));
      } catch (error) {
        return failure(`Search failed: ${messageOf(error)}`);
      }
    },
  );

  return server;
}

function flatten<T extends object>(
  ranked: Ranked<T>,
): T & { similarity: number; relevanceScore: number } {
  return { ...ranked.item, similarity: ranked.similarity, relevanceScore: ranked.relevanceScore };
}

function text(value: string): CallToolResult {
  return { content: [{ type: "text", text: value }] };
}

function failure(reason: string): CallToolResult {
  return { content: [{ type: "text", text: reason }], isError: true };
}
