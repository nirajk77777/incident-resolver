/**
 * The embed and rerank pipeline both searches share.
 *
 * A query is embedded, pgvector returns the nearest `candidates` rows by cosine
 * similarity, and the reranker narrows them to `topK` with relevance scores. The
 * providers are interfaces so the pipeline is tested with fakes; Cohere implements
 * them in `cohere.ts`.
 */

export type Embedder = {
  /** Embeds a search query (Cohere input type `search_query`). */
  embedQuery(text: string): Promise<number[]>;
  /** Embeds documents for indexing (Cohere input type `search_document`). */
  embedDocuments(texts: string[]): Promise<number[][]>;
};

export type RerankResult = { index: number; relevanceScore: number };

export type Reranker = {
  /** Returns the `topN` most relevant of `documents` for `query`, by index into `documents`. */
  rerank(query: string, documents: string[], topN: number): Promise<RerankResult[]>;
};

/** A row pgvector returned, with its cosine similarity to the query. */
export type Candidate<T> = { item: T; similarity: number };

/** A candidate the reranker kept, with its relevance score. */
export type Ranked<T> = Candidate<T> & { relevanceScore: number };

export type SearchRankedOptions<T> = {
  query: string;
  embedder: Embedder;
  reranker: Reranker;
  /** Nearest rows by cosine similarity, at most `limit` of them. */
  fetchCandidates(embedding: number[], limit: number): Promise<Candidate<T>[]>;
  /** The text the reranker scores for a candidate; the same text it was embedded from. */
  documentOf(item: T): string;
  /** How many rows to pull from pgvector before reranking. */
  candidates: number;
  /** How many rows to return after reranking. */
  topK: number;
};

export async function searchRanked<T>(options: SearchRankedOptions<T>): Promise<Ranked<T>[]> {
  const { query, embedder, reranker, fetchCandidates, documentOf, candidates, topK } = options;
  const embedding = await embedder.embedQuery(query);
  const nearest = await fetchCandidates(embedding, candidates);
  if (nearest.length === 0) return [];

  const documents = nearest.map((candidate) => documentOf(candidate.item));
  const reranked = await reranker.rerank(query, documents, Math.min(topK, nearest.length));

  return reranked
    .flatMap(({ index, relevanceScore }) => {
      const candidate = nearest[index];
      return candidate ? [{ ...candidate, relevanceScore }] : [];
    })
    .sort((a, b) => b.relevanceScore - a.relevanceScore);
}
