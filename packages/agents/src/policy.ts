import { ESCALATION_REPLY, type Verdict } from "@incident-resolver/shared";
import type { RunSummary } from "./run-summary";
import type { Triage } from "./schemas";
import { investigators } from "./subagents";

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

/**
 * PLAN.md's other procedure rule: a Ticket that is investigated at all runs all three
 * Investigators, and runs them in one turn so their spans overlap rather than queueing.
 * The Resolver's prompt states the same rule; these are the ways a run departed from it,
 * reported to whoever ran the Resolver rather than to the Reporter.
 */
export function investigationWarnings(summary: RunSummary): string[] {
  const ran = investigators.filter((name) => summary.subagentsInvoked.includes(name));
  if (ran.length === 0) return [];
  if (ran.length < investigators.length) {
    const missing = investigators.filter((name) => !summary.subagentsInvoked.includes(name));
    return [
      `The Resolver investigated without ${missing.join(" and ")}: an investigated Ticket runs all three Investigators`,
    ];
  }
  return ranInParallel(summary)
    ? []
    : [
        "The three Investigators were launched in separate turns rather than one, so their spans do not overlap",
      ];
}

/** Whether one model turn asked for all three Investigators, which is what makes them concurrent. */
export function ranInParallel(summary: RunSummary): boolean {
  return summary.delegationTurns.some((turn) => investigators.every((name) => turn.includes(name)));
}
