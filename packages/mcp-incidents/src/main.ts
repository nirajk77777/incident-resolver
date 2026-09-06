import { getConfig } from "@incident-resolver/shared/config";
import { createDb } from "@incident-resolver/shared/db";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCohereProviders } from "./cohere";
import { messageOf } from "./errors";
import { createIncidentsServer } from "./server";
import { createKnowledgeStore } from "./store";

/**
 * Stdio entry point, spawned by portal-api.
 *
 * Environment: DATABASE_URL, MODEL_EMBEDDINGS, MODEL_RERANK, and the KNOWLEDGE_SEARCH_*
 * knobs from the shared config, plus COHERE_API_KEY. The key is read straight from the
 * environment rather than config.ts because it is a secret, not a tunable.
 */
const config = getConfig();
const apiKey = process.env.COHERE_API_KEY;
if (!apiKey) {
  console.error("mcp-incidents failed to start: COHERE_API_KEY is not set");
  process.exit(1);
}

const db = createDb(config.infra.databaseUrl);
try {
  const server = createIncidentsServer({
    store: createKnowledgeStore(db),
    ...createCohereProviders({
      apiKey,
      embeddingModel: config.models.embeddings,
      rerankModel: config.models.rerank,
    }),
    candidates: config.knowledge.searchCandidates,
    topK: config.knowledge.searchTopK,
  });
  server.server.onclose = () => {
    void db.$client.end();
  };
  await server.connect(new StdioServerTransport());
  console.error(
    `mcp-incidents ready: ${config.models.embeddings} embeddings, ${config.models.rerank} rerank, ` +
      `top ${config.knowledge.searchTopK} of ${config.knowledge.searchCandidates}`,
  );
} catch (error) {
  console.error(`mcp-incidents failed to start: ${messageOf(error)}`);
  await db.$client.end();
  process.exit(1);
}
