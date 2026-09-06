import { CohereEmbeddings, CohereRerank } from "@langchain/cohere";
import type { Embedder, Reranker } from "./retrieval";

export type CohereOptions = {
  apiKey: string;
  /** `embed-v4.0`. The wrapper cannot set `output_dimension`, so vectors are its default 1536. */
  embeddingModel: string;
  /** `rerank-v3.5`. */
  rerankModel: string;
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
    model: options.embeddingModel,
  });
  const rerank = new CohereRerank({ apiKey: options.apiKey, model: options.rerankModel });
  return {
    embedder: embeddings,
    reranker: {
      rerank: (query, documents, topN) => rerank.rerank(documents, query, { topN }),
    },
  };
}
