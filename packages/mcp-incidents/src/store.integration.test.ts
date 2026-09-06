import {
  createDb,
  EMBEDDING_DIMENSIONS,
  loadConfig,
  runMigrations,
} from "@incident-resolver/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKnowledgeStore, type KnowledgeStore } from "./store";

// Needs `docker compose up`. Run with `pnpm test:integration`. No Cohere key needed:
// the vectors here are synthetic, so this proves the pgvector queries, not the models.

/** A unit vector along `axis`, optionally mixed with a second axis. */
function unit(axis: number, second?: { axis: number; weight: number }): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  vector[axis] = 1;
  if (second) vector[second.axis] = second.weight;
  const norm = Math.hypot(...vector);
  return vector.map((value) => value / norm);
}

const ids = {
  exact: "31000000-0000-4000-8000-000000000001",
  close: "31000000-0000-4000-8000-000000000002",
  far: "31000000-0000-4000-8000-000000000003",
  article: "41000000-0000-4000-8000-000000000001",
};

describe("knowledge store", () => {
  const db = createDb(loadConfig().infra.databaseUrl);
  let store: KnowledgeStore;

  beforeAll(async () => {
    await runMigrations(db);
    store = createKnowledgeStore(db);
    const base = {
      symptoms: "synthetic",
      rootCause: "synthetic",
      resolution: "synthetic",
      category: "unknown" as const,
      resolvedBy: "human" as const,
      author: "store test",
    };
    await store.insertIncident({ ...base, id: ids.exact, title: "exact" }, unit(0));
    await store.insertIncident(
      { ...base, id: ids.close, title: "close" },
      unit(0, { axis: 1, weight: 1 }),
    );
    await store.insertIncident(
      { ...base, id: ids.far, title: "far" },
      unit(0, { axis: 1, weight: 3 }),
    );
    await store.insertHelpArticle(
      { id: ids.article, title: "article", body: "synthetic", tags: ["a", "b"] },
      unit(2),
    );
  });

  afterAll(async () => {
    await db.$client.query("DELETE FROM knowledge.incidents WHERE author = 'store test'");
    await db.$client.query("DELETE FROM knowledge.help_articles WHERE id = $1", [ids.article]);
    await db.$client.end();
  });

  it("returns incidents nearest first with their cosine similarity", async () => {
    const results = await store.nearestIncidents(unit(0), 200);
    const ours = results.filter((result) => Object.values(ids).includes(result.item.id));
    expect(ours.map((result) => result.item.title)).toEqual(["exact", "close", "far"]);
    expect(ours[0]?.similarity).toBeCloseTo(1, 5);
    expect(ours[1]?.similarity).toBeCloseTo(Math.SQRT1_2, 5);
    expect(ours[2]?.similarity).toBeCloseTo(1 / Math.sqrt(10), 5);
  });

  it("respects the limit", async () => {
    const results = await store.nearestIncidents(unit(0), 1);
    expect(results).toHaveLength(1);
    expect(results[0]?.item.id).toBe(ids.exact);
  });

  it("reads one incident back with every field and no embedding", async () => {
    const incident = await store.getIncident(ids.close);
    expect(incident).toEqual({
      id: ids.close,
      title: "close",
      symptoms: "synthetic",
      rootCause: "synthetic",
      resolution: "synthetic",
      category: "unknown",
      sourceTicketId: null,
      resolvedBy: "human",
      author: "store test",
      createdAt: expect.any(Date),
    });
    expect(await store.getIncident("31000000-0000-4000-8000-0000000000ff")).toBeNull();
  });

  it("inserts an incident with a generated id and timestamp", async () => {
    const saved = await store.insertIncident(
      {
        title: "generated",
        symptoms: "synthetic",
        rootCause: "synthetic",
        resolution: "synthetic",
        category: "data_issue",
        resolvedBy: "agent",
        author: "store test",
        sourceTicketId: "20000000-0000-4000-8000-0000000000aa",
      },
      unit(5),
    );
    expect(saved.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(saved.createdAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(saved.sourceTicketId).toBe("20000000-0000-4000-8000-0000000000aa");
  });

  it("searches help articles the same way and keeps their tags", async () => {
    const results = await store.nearestHelpArticles(unit(2), 200);
    const [first] = results;
    expect(first?.item).toEqual({
      id: ids.article,
      title: "article",
      body: "synthetic",
      tags: ["a", "b"],
    });
    expect(first?.similarity).toBeCloseTo(1, 5);
  });
});
