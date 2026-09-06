import type { HelpArticleRecord, IncidentRecord } from "./store";

/**
 * The text an Incident or Help article is embedded from and reranked on. One
 * rendering for both, so what the reranker scores is what pgvector matched.
 */

export type IncidentText = Pick<
  IncidentRecord,
  "title" | "symptoms" | "rootCause" | "resolution" | "category"
>;

export function incidentDocument(incident: IncidentText): string {
  return [
    incident.title,
    `Category: ${incident.category}`,
    `Symptoms: ${incident.symptoms}`,
    `Root cause: ${incident.rootCause}`,
    `Resolution: ${incident.resolution}`,
  ].join("\n");
}

export type HelpArticleText = Pick<HelpArticleRecord, "title" | "body" | "tags">;

export function helpArticleDocument(article: HelpArticleText): string {
  const tags = article.tags.length > 0 ? `\nTags: ${article.tags.join(", ")}` : "";
  return `${article.title}\n${article.body}${tags}`;
}
