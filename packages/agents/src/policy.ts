import type { Verdict } from "@incident-resolver/shared";
import type { Triage } from "./schemas";

/** The holding Reply a Reporter gets when the Ticket is handed to a human. */
export const ESCALATION_REPLY =
  "Thanks for your report. We have not been able to confirm the cause yet, so a member of the team is looking into it and will get back to you shortly.";

/**
 * The fast path rule from PLAN.md: a Question with a Help article at or above the Confidence
 * threshold is answered from the article with no Investigators. The Resolver's prompt states
 * the same rule; this is the code's reading of it, used to spot when a run deviated.
 */
export function isFastPath(triage: Triage, confidenceThreshold: number): boolean {
  return (
    triage.category === "question" &&
    triage.helpArticleIds.length > 0 &&
    triage.bestHelpArticle !== null &&
    triage.confidence >= confidenceThreshold
  );
}

/**
 * Confidence below the threshold escalates, whatever the model wrote in `outcome`. The root
 * cause and Evidence are kept so the human picking it up sees what was found; the Reply is
 * swapped for the holding message because a confident-sounding answer below threshold must
 * not reach the Reporter.
 */
export function applyConfidencePolicy(verdict: Verdict, confidenceThreshold: number): Verdict {
  if (verdict.outcome === "escalated" || verdict.confidence >= confidenceThreshold) return verdict;
  return { ...verdict, outcome: "escalated", reply: ESCALATION_REPLY };
}
