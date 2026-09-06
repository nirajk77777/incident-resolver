import { CohereEmbeddings, CohereRerank } from "@langchain/cohere";
import type { Embedder, Reranker } from "./retrieval";

export type CohereOptions = {
  apiKey: string;
  /**
   * `config.models`: `embeddings` is embed-v4.0, whose default 1536 dimensions the wrapper
   * cannot change, and `rerank` is rerank-v3.5.
   */
  models: { embeddings: string; rerank: string };
};

/**
 * Cohere through the LangChain wrappers. `CohereEmbeddings` already sends
 * `search_document` for `embedDocuments` and `search_query` for `embedQuery`.
 */
export function createCohereProviders(options: CohereOptions): {
  embedder: Embedder;
  reranker: Reranker;
} {
  const embeddings = new CohereEmbeddings({
    apiKey: options.apiKey,
    model: options.models.embeddings,
  });
  const rerank = new CohereRerank({ apiKey: options.apiKey, model: options.models.rerank });
  return {
    embedder: embeddings,
    reranker: {
      rerank: (query, documents, topN) => rerank.rerank(documents, query, { topN }),
    },
  };
}
