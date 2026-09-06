import { z } from "zod";
import { incidentCategories, outcomes } from "./db/schema";

export { type Outcome, outcomes } from "./db/schema";

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

/**
 * The holding Reply a Reporter gets when the Ticket is handed to a human: Confidence below
 * the threshold, or a run that failed before it reached a Verdict.
 */
export const ESCALATION_REPLY =
  "Thanks for your report. We have not been able to confirm the cause yet, so a member of the team is looking into it and will get back to you shortly.";

/**
 * The Verdict a run ends with once the Ticket is handed to a human. The root cause and the
 * Evidence are kept, so whoever picks it up sees everything that was found; the Reply is
 * swapped for the holding message, because an answer nobody trusts must not reach the
 * Reporter. `note` is appended to the root cause when there is something to say about why.
 *
 * It swaps the Reply even on a Verdict that already said `escalated`: a run that asked for a
 * human is one whose own wording is not to be sent, and the holding message is what the
 * Reporter reads until a person writes them a real Reply.
 */
export function escalated(verdict: Verdict, note?: string): Verdict {
  return {
    ...verdict,
    outcome: "escalated",
    reply: ESCALATION_REPLY,
    ...(note ? { rootCause: `${verdict.rootCause} ${note}` } : {}),
  };
}

/**
 * Confidence below the threshold escalates, whatever the model wrote in `outcome`. Applied
 * where a run reports its Verdict and again where the portal closes a Ticket on one, so the
 * rule holds for every Resolver behind the seam rather than only for the one that knows it.
 *
 * A Verdict that already escalated keeps its own Reply: the Resolver decided to hand the
 * Ticket over and wrote the holding message itself, and this rule has nothing to correct.
 */
export function applyConfidencePolicy(verdict: Verdict, confidenceThreshold: number): Verdict {
  if (verdict.outcome === "escalated" || verdict.confidence >= confidenceThreshold) return verdict;
  return escalated(verdict);
}

/**
 * Why a Ticket a Reviewer is reading went to them rather than closing as the Resolver wrote it.
 * Lives beside the rule so the timeline entry and the operator's warning say the same thing.
 */
export function belowThresholdReason(verdict: Verdict, confidenceThreshold: number): string {
  return (
    `Confidence ${verdict.confidence} is below the threshold ${confidenceThreshold}, ` +
    `so the Ticket was escalated rather than closed as ${verdict.outcome}.`
  );
}
