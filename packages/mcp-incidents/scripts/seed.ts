import { getConfig } from "@incident-resolver/shared/config";
import { createDb, runMigrations } from "@incident-resolver/shared/db";
import { createCohereProviders } from "../src/cohere";
import { seedKnowledge } from "../src/seed";
import { createKnowledgeStore } from "../src/store";

// Seeds the knowledge schema with ShopLite's twenty Incidents and its Help articles.
// Needs `docker compose up` and COHERE_API_KEY. Safe to rerun; it resets both tables.

const config = getConfig();
const apiKey = process.env.COHERE_API_KEY;
if (!apiKey) {
  console.error("COHERE_API_KEY is not set; the seed embeds every record through Cohere");
  process.exit(1);
}

const db = createDb(config.infra.databaseUrl);
try {
  await runMigrations(db);
  const { embedder } = createCohereProviders({ apiKey, models: config.models });
  const result = await seedKnowledge(createKnowledgeStore(db), embedder);
  console.log(
    `Seeded ${result.incidents} Incidents and ${result.helpArticles} Help articles into the knowledge schema`,
  );
} finally {
  await db.$client.end();
}
