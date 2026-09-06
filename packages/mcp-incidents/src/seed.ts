import { helpArticleDocument, incidentDocument } from "./documents";
import type { Embedder } from "./retrieval";
import { seedHelpArticles, seedIncidents } from "./seed-data";
import type { KnowledgeStore } from "./store";

export type SeedResult = { incidents: number; helpArticles: number };

/**
 * Empties the knowledge schema and writes the seeded Incidents and Help articles,
 * embedding each one with `embedder`. Safe to rerun; it resets both tables.
 */
export async function seedKnowledge(
  store: KnowledgeStore,
  embedder: Embedder,
): Promise<SeedResult> {
  const [incidentVectors, articleVectors] = await Promise.all([
    embedder.embedDocuments(seedIncidents.map(incidentDocument)),
    embedder.embedDocuments(seedHelpArticles.map(helpArticleDocument)),
  ]);

  await store.clear();
  for (const [index, incident] of seedIncidents.entries()) {
    await store.insertIncident(incident, vectorAt(incidentVectors, index));
  }
  for (const [index, article] of seedHelpArticles.entries()) {
    await store.insertHelpArticle(article, vectorAt(articleVectors, index));
  }
  return { incidents: seedIncidents.length, helpArticles: seedHelpArticles.length };
}

function vectorAt(vectors: number[][], index: number): number[] {
  const vector = vectors[index];
  if (!vector) throw new Error(`The embedder returned no vector for document ${index}`);
  return vector;
}
