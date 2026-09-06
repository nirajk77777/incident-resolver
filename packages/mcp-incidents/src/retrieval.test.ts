import { describe, expect, it, vi } from "vitest";
import { type Candidate, type Embedder, type Reranker, searchRanked } from "./retrieval";

type Item = { id: string; text: string };

const queryVector = [0.1, 0.2, 0.3];

function fakeEmbedder(): Embedder {
  return {
    embedQuery: vi.fn(async () => queryVector),
    embedDocuments: vi.fn(async (texts: string[]) => texts.map(() => queryVector)),
  };
}

function candidatesOf(...ids: string[]): Candidate<Item>[] {
  return ids.map((id, index) => ({
    item: { id, text: `document ${id}` },
    similarity: 1 - index * 0.1,
  }));
}

describe("searchRanked", () => {
  it("embeds the query, fetches the nearest candidates, then reranks them to the top k", async () => {
    const embedder = fakeEmbedder();
    const fetchCandidates = vi.fn(async () => candidatesOf("a", "b", "c", "d", "e"));
    const reranker: Reranker = {
      rerank: vi.fn(async () => [
        { index: 3, relevanceScore: 0.9 },
        { index: 0, relevanceScore: 0.5 },
        { index: 4, relevanceScore: 0.2 },
      ]),
    };

    const results = await searchRanked({
      query: "stale cart total",
      embedder,
      reranker,
      fetchCandidates,
      documentOf: (item) => item.text,
      candidates: 20,
      topK: 3,
    });

    expect(embedder.embedQuery).toHaveBeenCalledWith("stale cart total");
    expect(fetchCandidates).toHaveBeenCalledWith(queryVector, 20);
    expect(reranker.rerank).toHaveBeenCalledWith(
      "stale cart total",
      ["document a", "document b", "document c", "document d", "document e"],
      3,
    );
    expect(results).toEqual([
      { item: { id: "d", text: "document d" }, similarity: 0.7, relevanceScore: 0.9 },
      { item: { id: "a", text: "document a" }, similarity: 1, relevanceScore: 0.5 },
      { item: { id: "e", text: "document e" }, similarity: 0.6, relevanceScore: 0.2 },
    ]);
  });

  it("orders by relevance score even if the reranker returns them unsorted", async () => {
    const reranker: Reranker = {
      rerank: async () => [
        { index: 0, relevanceScore: 0.1 },
        { index: 1, relevanceScore: 0.8 },
      ],
    };
    const results = await searchRanked({
      query: "q",
      embedder: fakeEmbedder(),
      reranker,
      fetchCandidates: async () => candidatesOf("a", "b"),
      documentOf: (item) => item.text,
      candidates: 20,
      topK: 3,
    });
    expect(results.map((result) => result.item.id)).toEqual(["b", "a"]);
  });

  it("skips the reranker and returns nothing when the store has no candidates", async () => {
    const reranker: Reranker = { rerank: vi.fn(async () => []) };
    const results = await searchRanked({
      query: "q",
      embedder: fakeEmbedder(),
      reranker,
      fetchCandidates: async () => [],
      documentOf: (item: Item) => item.text,
      candidates: 20,
      topK: 3,
    });
    expect(results).toEqual([]);
    expect(reranker.rerank).not.toHaveBeenCalled();
  });

  it("never asks the reranker for more results than there are candidates", async () => {
    const reranker: Reranker = {
      rerank: vi.fn(async (_query, _documents, topN) =>
        Array.from({ length: topN }, (_, index) => ({ index, relevanceScore: 1 - index / 10 })),
      ),
    };
    const results = await searchRanked({
      query: "q",
      embedder: fakeEmbedder(),
      reranker,
      fetchCandidates: async () => candidatesOf("a", "b"),
      documentOf: (item) => item.text,
      candidates: 20,
      topK: 3,
    });
    expect(reranker.rerank).toHaveBeenCalledWith("q", ["document a", "document b"], 2);
    expect(results).toHaveLength(2);
  });
});
