import {
  dataFixProposalSchema,
  evidenceReferenceSchema,
  incidentCategories,
} from "@incident-resolver/shared";
import { z } from "zod";

export const severities = ["low", "medium", "high", "critical"] as const;
export const components = [
  "catalog",
  "cart",
  "checkout",
  "payments",
  "discounts",
  "orders",
  "account",
  "storefront",
  "infrastructure",
  "unknown",
] as const;

/** A Help article as Triage saw it in the search result. */
export const helpArticleSchema = z.object({
  id: z.uuid(),
  title: z.string().min(1),
  body: z.string().min(1),
});

/** What the Triage subagent returns: the first classification of a Ticket. */
export const triageSchema = z.object({
  category: z.enum(incidentCategories).describe("What kind of problem the Ticket is"),
  severity: z.enum(severities),
  component: z.enum(components).describe("The ShopLite area involved"),
  hypothesis: z
    .string()
    .min(1)
    .describe("What probably happened and which tables or routes the investigators should check"),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe(
      "For a question, the relevance score of the best Help article; otherwise certainty in the Category",
    ),
  helpArticleIds: z
    .array(z.uuid())
    .describe(
      "Ids of the Help articles that answer the Ticket, best first; empty unless a question",
    ),
  bestHelpArticle: helpArticleSchema
    .nullable()
    .describe("The article to answer from, copied from the search result; null unless a question"),
});
export type Triage = z.infer<typeof triageSchema>;

/** What the Data Investigator returns: Evidence from the database, and a Proposal if a row is wrong. */
export const dataInvestigationSchema = z.object({
  summary: z.string().min(1).describe("What the database shows, in at most three sentences"),
  evidence: z
    .array(evidenceReferenceSchema)
    .describe("Each fact with the exact SQL that produced it as provenance"),
  proposal: dataFixProposalSchema
    .nullable()
    .describe("The Proposal returned by propose_data_fix, unchanged, or null"),
});
export type DataInvestigation = z.infer<typeof dataInvestigationSchema>;
