import {
  applyConfidencePolicy,
  belowThresholdReason,
  escalated,
  type Verdict,
} from "@incident-resolver/shared";
import { ESCALATE_TO_HUMAN } from "./escalate";
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

/** The two things about a run's ending that are the portal's to decide, not the model's. */
export type Ending = {
  confidenceThreshold: number;
  /** Why the run called `escalate_to_human`, or undefined when it never did. */
  escalationAsked: string | undefined;
};

/**
 * The Verdict a run actually ends with. A run that asked for a human gets one, and so does one
 * whose Confidence is below the threshold: neither is the model's to overrule by writing a
 * different Outcome afterwards. The root cause and the Evidence survive both, since they are
 * what the person picking the Ticket up reads; only the Reply is swapped, because a
 * confident-sounding answer nobody trusts must not reach the Reporter.
 */
export function settleVerdict(verdict: Verdict, ending: Ending): Verdict {
  if (ending.escalationAsked !== undefined) {
    return escalated(verdict, `The Resolver asked for a human: ${ending.escalationAsked}`);
  }
  return applyConfidencePolicy(verdict, ending.confidenceThreshold);
}

/** How a settled Verdict departed from what the model wrote, for whoever runs the Resolver. */
export function endingWarnings(verdict: Verdict, settled: Verdict, ending: Ending): string[] {
  if (settled.outcome === verdict.outcome) return [];
  return [
    ending.escalationAsked === undefined
      ? belowThresholdReason(verdict, ending.confidenceThreshold)
      : `The Resolver called ${ESCALATE_TO_HUMAN} and then returned ${verdict.outcome}: the Ticket was escalated`,
  ];
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
