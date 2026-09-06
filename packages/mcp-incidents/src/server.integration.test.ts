import { fileURLToPath } from "node:url";
import { createDb, loadConfig, runMigrations } from "@incident-resolver/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCohereProviders } from "./cohere";
import type { Embedder } from "./retrieval";
import { seedKnowledge } from "./seed";
import { seedHelpArticleIds, seedIncidentIds } from "./seed-data";
import type { SearchResult } from "./server";
import {
  createKnowledgeStore,
  type HelpArticleRecord,
  type IncidentRecord,
  type KnowledgeStore,
} from "./store";

// Needs `docker compose up`, this repo's `pnpm db:migrate`, and COHERE_API_KEY. Run with
// `pnpm test:integration`. Without the key the suite is skipped, since every assertion
// here depends on what embed-v4.0 and rerank-v3.5 actually return.
//
// Every assertion goes through the MCP client over stdio, the way portal-api will use
// the server. The knowledge schema is reseeded first so the results are deterministic.

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const config = loadConfig();
const apiKey = process.env.COHERE_API_KEY;

const staleCartTotalIds: string[] = [
  seedIncidentIds.staleCartTotal,
  ...seedIncidentIds.staleCartTotalDuplicates,
];

async function startServer(env: Record<string, string> = {}): Promise<Client> {
  const client = new Client({ name: "mcp-incidents-test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/main.ts"],
      cwd: packageDir,
      env: { ...(process.env as Record<string, string>), ...env },
      stderr: "pipe",
    }),
  );
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const [first] = result.content as Array<{ type: string; text: string }>;
  return { text: first?.text ?? "", isError: result.isError === true };
}

async function searchIncidents(client: Client, text: string, k?: number) {
  const reply = await call(client, "search_similar_incidents", k ? { text, k } : { text });
  expect(reply.isError, reply.text).toBe(false);
  return JSON.parse(reply.text) as SearchResult<IncidentRecord>;
}

async function searchHelp(client: Client, text: string) {
  const reply = await call(client, "search_help_articles", { text });
  expect(reply.isError, reply.text).toBe(false);
  return JSON.parse(reply.text) as SearchResult<HelpArticleRecord>;
}

describe.skipIf(!apiKey)("mcp-incidents over the MCP client", () => {
  const db = createDb(config.infra.databaseUrl);
  let store: KnowledgeStore;
  let embedder: Embedder;
  let client: Client;
  const savedIds: string[] = [];

  beforeAll(async () => {
    await runMigrations(db);
    store = createKnowledgeStore(db);
    embedder = createCohereProviders({ apiKey: apiKey as string, models: config.models }).embedder;
    await seedKnowledge(store, embedder);
    client = await startServer();
  });

  afterAll(async () => {
    await client?.close();
    if (savedIds.length > 0) {
      await db.$client.query("DELETE FROM knowledge.incidents WHERE id = ANY($1)", [savedIds]);
    }
    await db.$client.end();
  });

  it("exposes the four tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "get_incident",
      "save_incident",
      "search_help_articles",
      "search_similar_incidents",
    ]);
  });

  it("refuses to start without a Cohere key", async () => {
    await expect(startServer({ COHERE_API_KEY: "" })).rejects.toThrow();
  });

  describe("search_similar_incidents", () => {
    const staleCartQuery =
      "Cart total wrong after removing item: the cart tag in the header still shows the old item count and total after I removed a product, even after a refresh";

    it("has vector search rank the red herring among the nearest candidates", async () => {
      const nearest = await store.nearestIncidents(await embedder.embedQuery(staleCartQuery), 20);
      const rank = nearest.findIndex((c) => c.item.id === seedIncidentIds.redHerring);
      expect(rank).toBeGreaterThanOrEqual(0);
      expect(rank).toBeLessThan(6);
    });

    it("ranks a stale cart total Incident first and the red herring below it after rerank", async () => {
      const { results } = await searchIncidents(client, staleCartQuery);
      expect(results).toHaveLength(3);
      expect(staleCartTotalIds).toContain(results[0]?.id);

      const scores = results.map((result) => result.relevanceScore);
      expect(scores).toEqual([...scores].sort((a, b) => b - a));
      for (const result of results) {
        expect(result.relevanceScore).toBeGreaterThanOrEqual(0);
        expect(result.relevanceScore).toBeLessThanOrEqual(1);
        expect(result.similarity).toBeGreaterThan(0);
      }

      // The red herring should be beaten by every stale cart total Incident that made the cut.
      const redHerringRank = results.findIndex((r) => r.id === seedIncidentIds.redHerring);
      const bestStaleRank = results.findIndex((r) => staleCartTotalIds.includes(r.id));
      if (redHerringRank !== -1) expect(bestStaleRank).toBeLessThan(redHerringRank);
    });

    it("carries the documented UPDATE in the top match's resolution", async () => {
      const { results } = await searchIncidents(
        client,
        "header cart badge stale after removing an item",
      );
      const withSql = results.filter((r) => r.resolution.includes("UPDATE shoplite.cart_totals"));
      expect(withSql.length).toBeGreaterThan(0);
    });

    it("honours k up to the candidate pool", async () => {
      const { results } = await searchIncidents(client, "checkout failed", 5);
      expect(results).toHaveLength(5);
      const tooMany = await call(client, "search_similar_incidents", { text: "x", k: 999 });
      expect(tooMany.isError).toBe(true);
    });
  });

  describe("get_incident", () => {
    it("returns the full record", async () => {
      const reply = await call(client, "get_incident", { id: seedIncidentIds.staleCartTotal });
      expect(reply.isError, reply.text).toBe(false);
      const incident = JSON.parse(reply.text) as IncidentRecord;
      expect(incident).toMatchObject({
        id: seedIncidentIds.staleCartTotal,
        category: "data_issue",
        resolvedBy: "human",
        author: "Priya Natarajan",
      });
      expect(incident.resolution).toContain("UPDATE shoplite.cart_totals");
      expect(incident).not.toHaveProperty("embedding");
    });

    it("fails clearly for an unknown id", async () => {
      const reply = await call(client, "get_incident", {
        id: "30000000-0000-4000-8000-0000000000ff",
      });
      expect(reply.isError).toBe(true);
      expect(reply.text).toContain("No Incident");
    });
  });

  describe("save_incident", () => {
    it("saves a record that the next search finds", async () => {
      const reply = await call(client, "save_incident", {
        title: "Insulated Bottle (BOTTLE-01) shows negative stock after a refund",
        symptoms:
          "Catalog shows stock -1 for the Insulated Bottle after a refunded order was restocked twice.",
        rootCause: "The refund handler restocks on both the refund event and the return receipt.",
        resolution:
          "UPDATE shoplite.products SET stock = 0 WHERE sku = 'BOTTLE-01'; fix restock to run once.",
        category: "data_issue",
        resolvedBy: "agent",
        author: "Resolver",
        sourceTicketId: "20000000-0000-4000-8000-000000000999",
      });
      expect(reply.isError, reply.text).toBe(false);
      const saved = JSON.parse(reply.text) as IncidentRecord;
      savedIds.push(saved.id);
      expect(saved).toMatchObject({
        category: "data_issue",
        resolvedBy: "agent",
        author: "Resolver",
        sourceTicketId: "20000000-0000-4000-8000-000000000999",
      });

      const { results } = await searchIncidents(
        client,
        "product stock went negative after a refund",
      );
      expect(results[0]?.id).toBe(saved.id);
    });

    it("rejects a record with an unknown Category", async () => {
      const reply = await call(client, "save_incident", {
        title: "t",
        symptoms: "s",
        rootCause: "r",
        resolution: "x",
        category: "mystery",
        resolvedBy: "agent",
        author: "Resolver",
      });
      expect(reply.isError).toBe(true);
    });
  });

  describe("search_help_articles", () => {
    it("answers images not loading with the clear cache article first", async () => {
      const { results } = await searchHelp(client, "Product images stopped loading after the sale");
      expect(results[0]?.id).toBe(seedHelpArticleIds.clearCache);
      expect(results[0]?.title).toMatch(/clear your cache/i);
      expect(results[0]?.tags).toContain("cache");
      expect(results[0]?.relevanceScore).toBeGreaterThan(0.5);
    });

    it("returns the top three with descending relevance", async () => {
      const { results } = await searchHelp(client, "how do I cancel my order");
      expect(results).toHaveLength(3);
      expect(results[0]?.title).toMatch(/cancel/i);
      const scores = results.map((r) => r.relevanceScore);
      expect(scores).toEqual([...scores].sort((a, b) => b - a));
    });
  });
});
