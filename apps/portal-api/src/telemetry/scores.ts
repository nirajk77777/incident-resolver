import type { LangfuseCredentials } from "@incident-resolver/agents";
import type { ApprovalAction, Decision, Outcome } from "@incident-resolver/shared";
import { LangfuseClient } from "@langfuse/client";

/**
 * Every human judgement on a run, written back onto its Langfuse trace as a score. That is
 * what turns the approval gate into an evaluation dataset: each Proposal carries what a
 * Reviewer thought of it, and each Ticket carries whether the agent resolved it or handed it
 * over. PLAN.md section 4.
 *
 * Scores are queued and flushed by the client, so nothing here holds up a Decision; a portal
 * running without the Langfuse keys writes none, exactly as it traces none.
 */

/** The score a Decision is written as, in the words PLAN.md section 4 names. */
const decisionValues = {
  approve: "approved",
  edit: "edited",
  reject: "rejected",
} as const satisfies Record<Decision, string>;

/** The score an Outcome is written as: whether the agent resolved the Ticket, or handed it over. */
export function outcomeValue(outcome: Outcome): "resolved" | "escalated" {
  return outcome === "escalated" ? "escalated" : "resolved";
}

export type DecisionScore = {
  action: ApprovalAction;
  decision: Decision;
  /** The Reviewer's reason, when they rejected the Proposal. */
  reason?: string | null;
};

export type ScoreWriter = {
  /** What a Reviewer decided about one Proposal, on the trace of the run that raised it. */
  decision(traceId: string | null, score: DecisionScore): void;
  /** How the Ticket ended, on the trace of the run that ended it. */
  outcome(traceId: string | null, outcome: Outcome): void;
  /** Sends whatever is still queued. Called when the portal closes. */
  flush(): Promise<void>;
};

/** A writer that keeps no scores, for a portal with no Langfuse keys and for tests. */
export const noScores: ScoreWriter = {
  decision: () => {},
  outcome: () => {},
  flush: async () => {},
};

export function createScoreWriter(credentials: LangfuseCredentials): ScoreWriter {
  const { publicKey, secretKey, baseUrl } = credentials;
  if (!publicKey || !secretKey) return noScores;
  const client = new LangfuseClient({ publicKey, secretKey, baseUrl });

  return {
    decision(traceId, { action, decision, reason }) {
      // A run that was never traced has nothing to hang a score on.
      if (!traceId) return;
      client.score.create({
        traceId,
        name: "decision",
        value: decisionValues[decision],
        dataType: "CATEGORICAL",
        comment: reason ? `${action}: ${reason}` : action,
      });
    },

    outcome(traceId, outcome) {
      if (!traceId) return;
      client.score.create({
        traceId,
        name: "outcome",
        value: outcomeValue(outcome),
        dataType: "CATEGORICAL",
        comment: outcome,
      });
    },

    flush() {
      return client.score.flush();
    },
  };
}
