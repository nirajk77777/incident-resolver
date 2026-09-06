import { z } from "zod";
import { incidentCategories } from "./db/schema";

/** How a Ticket ended, see CONTEXT.md. Exactly one per Ticket. */
export const outcomes = ["answered", "data_fixed", "fix_proposed", "escalated"] as const;
export type Outcome = (typeof outcomes)[number];

/** A fact gathered during investigation, with where it came from. */
export const evidenceReferenceSchema = z.object({
  fact: z.string().min(1).describe("One fact the investigation established, in plain words"),
  provenance: z
    .string()
    .min(1)
    .describe(
      "Where the fact came from: the tool and the exact query, the log line, the trace id, or the Incident or Help article id",
    ),
});
export type EvidenceReference = z.infer<typeof evidenceReferenceSchema>;

/**
 * The Resolver's structured final output for a Ticket. The Reply and the Incident record
 * are derived from it deterministically, never by another model call.
 */
export const verdictSchema = z.object({
  outcome: z.enum(outcomes).describe("How the Ticket ended"),
  category: z
    .enum(incidentCategories)
    .describe("Triage's Category, confirmed or corrected by the Evidence"),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("Certainty, from 0 to 1, that this Verdict is right"),
  rootCause: z.string().min(1).describe("What actually happened, in one or two sentences"),
  evidence: z
    .array(evidenceReferenceSchema)
    .describe("The facts the Verdict rests on, each with provenance"),
  reply: z
    .string()
    .min(1)
    .describe(
      "The message to the Reporter: customer-facing for customer Tickets, an internal note for tester and Sentinel Tickets",
    ),
});
export type Verdict = z.infer<typeof verdictSchema>;
