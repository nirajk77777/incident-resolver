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

/** What the Log Investigator returns: Evidence from ShopLite's logs, traces, and metrics. */
export const logInvestigationSchema = z.object({
  summary: z.string().min(1).describe("What the telemetry shows, in at most three sentences"),
  evidence: z
    .array(evidenceReferenceSchema)
    .describe(
      "Each fact with the tool call that produced it as provenance: the LogQL or PromQL, the trace id, and the timestamp",
    ),
  traceIds: z
    .array(z.string().regex(/^[0-9a-f]{32}$/i, "A trace id is 32 hex characters"))
    .describe("Every ShopLite trace id seen, newest first, so the Ticket can link to the request"),
  errorRate: z
    .number()
    .min(0)
    .max(1)
    .nullable()
    .describe("The failing route's error ratio when one was measured, or null"),
});
export type LogInvestigation = z.infer<typeof logInvestigationSchema>;

/** One past Incident the Historian judged worth acting on. */
export const incidentMatchSchema = z.object({
  id: z.uuid().describe("The Incident id, as returned by search_similar_incidents"),
  title: z.string().min(1),
  rootCause: z
    .string()
    .min(1)
    .describe("What that Incident says was wrong, copied from the record"),
  resolution: z
    .string()
    .min(1)
    .describe("What fixed it, copied from the record: the SQL, the code change, or the answer"),
  relevanceScore: z.number().min(0).max(1).describe("The rerank score the search returned"),
});
export type IncidentMatch = z.infer<typeof incidentMatchSchema>;

/** What the Incident Historian returns: the past Incidents that match, after rerank. */
export const incidentSearchSchema = z.object({
  summary: z
    .string()
    .min(1)
    .describe("Whether a past Incident matches and what it says, in at most three sentences"),
  matches: z
    .array(incidentMatchSchema)
    .describe("The Incidents worth acting on, best first; empty when nothing genuinely matches"),
  evidence: z
    .array(evidenceReferenceSchema)
    .describe("Each fact with the Incident id and the search that found it as provenance"),
});
export type IncidentSearch = z.infer<typeof incidentSearchSchema>;

/**
 * What the Code RCA subagent returns: the root cause of a code bug, where it lives, and the
 * evidence that it is fixed. The Fix Shipper reads `patch.files` to know what to push and the
 * rest to write the pull request body, and the Resolver puts `rootCause` in its Verdict.
 *
 * Everything but the root cause and the test result is nullable, because Code RCA is told to
 * stop and say so rather than patch speculatively when it cannot find the cause or cannot fix
 * it without changing far more than the Ticket is about. A schema that insisted on a file, a
 * line and a changed file would leave it inventing them to answer at all, which is the one
 * thing a report a human acts on must not do.
 */
export const codeRcaSchema = z.object({
  rootCause: z
    .string()
    .min(1)
    .describe(
      "What the code does wrong and why it produces what the Reporter saw, or what stopped you finding out",
    ),
  file: z
    .string()
    .min(1)
    .nullable()
    .describe(
      "The Workspace-relative path of the file the defect is in, such as apps/api/src/domain/order.ts; null when you did not find it",
    ),
  line: z
    .number()
    .int()
    .positive()
    .nullable()
    .describe("The line in that file the defect is on; null when you did not find it"),
  failingTest: z
    .object({
      file: z.string().min(1).describe("Workspace-relative path of the test file"),
      name: z.string().min(1).describe("The test's name, as it reads in the file"),
    })
    .nullable()
    .describe(
      "The test written to reproduce the bug, which failed before the patch; null when you wrote none",
    ),
  patch: z
    .object({
      files: z
        .array(z.string().min(1))
        .min(1)
        .describe("Every file changed in the Workspace, from git_diff_names"),
      summary: z.string().min(1).describe("What the patch changes, in at most three sentences"),
    })
    .nullable()
    .describe("The fix as it stands in the Workspace; null when you changed nothing"),
  testsGreen: z
    .boolean()
    .describe(
      "Whether the last run_tests reported the whole suite passing. False whenever it did not, including when you patched nothing",
    ),
});
export type CodeRca = z.infer<typeof codeRcaSchema>;
