import type { Verdict } from "@incident-resolver/shared";
import type { ResolverDecision, ResolverEvent, ResolverRun, TicketResolver } from "./resolver";

/**
 * The Verdict the fake reaches when nothing is proposed: demo moment one, a card the mock
 * gateway declines because it ends in 0002, answered from what the logs say the gateway
 * replied.
 */
export const FAKE_VERDICT: Verdict = {
  outcome: "answered",
  category: "user_error",
  confidence: 0.86,
  rootCause:
    "The payment gateway declined the card for insufficient funds and the storefront showed a generic checkout failure instead of the reason.",
  evidence: [
    {
      fact: "The checkout attempt was refused by the gateway with reason insufficient_funds",
      provenance: "search_logs: payment declined by gateway: insufficient_funds",
    },
  ],
  reply:
    "Thanks for reporting this. Your bank declined the payment for insufficient funds, which our checkout page reported only as a generic failure. Please try another card or top up the account and check out again.",
};

/** The fixed script, in order. The Verdict is appended by `resolve`. */
const SCRIPT: ResolverEvent[] = [
  { type: "subagent_start", name: "triage" },
  {
    type: "subagent_end",
    name: "triage",
    summary: "A checkout question from a customer, probably a declined card",
  },
  { type: "subagent_start", name: "data-investigator" },
  {
    type: "tool_call",
    name: "run_readonly_sql",
    args: { sql: "SELECT status, failure_reason FROM orders WHERE customer_id = $1 LIMIT 5" },
  },
  {
    type: "tool_result",
    name: "run_readonly_sql",
    result: { rowCount: 1, rows: [{ status: "payment_failed", failure_reason: "declined" }] },
  },
  {
    type: "subagent_end",
    name: "data-investigator",
    summary: "The order never completed: the payment was declined",
  },
  { type: "message", text: "The gateway declined the card, so nothing was charged." },
];

export type FakeResolverOptions = {
  /** Pause between events, so a demo timeline arrives one card at a time. */
  stepDelayMs?: number;
  /**
   * A data fix to take to the approval gate rather than answering outright. Given one, the
   * fake proposes it, stops, and finishes according to what the Reviewer decided — which is
   * how the whole gate, including running the approved statement, is exercised with no model
   * behind it.
   */
  propose?: { sql: string; reason: string } | undefined;
};

/** Rejects when the run is aborted, so a cancelled run stops between steps. */
function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** How a Ticket whose data fix a Reviewer approved ends. */
function fixedVerdict(applied: string): Verdict {
  return {
    outcome: "data_fixed",
    category: "data_issue",
    confidence: 0.91,
    rootCause:
      "The denormalised cart_totals row was never refreshed when the item was removed, so the badge kept the old count and total.",
    evidence: [{ fact: "The approved fix ran", provenance: `apply_data_fix: ${applied}` }],
    reply: "We have corrected the total on your cart. Thanks for spotting it.",
  };
}

/** How it ends when the Reviewer refused: nothing was changed, and a person takes it on. */
function rejectedVerdict(reason: string): Verdict {
  return {
    outcome: "escalated",
    category: "data_issue",
    confidence: 0.91,
    rootCause: `A Reviewer rejected the proposed data fix: ${reason}`,
    evidence: [],
    reply:
      "Thanks for your report. We have not corrected this yet, so a member of the team is looking into it.",
  };
}

/**
 * A Resolver that investigates nothing and reaches a scripted Verdict. It exists so the whole
 * Ticket lifecycle — timeline, SSE, the approval gate, Outcome, Reply — is testable over HTTP
 * with no model behind it. The real Resolver plugs into the same seam.
 */
export function createFakeResolver({
  stepDelayMs = 0,
  propose,
}: FakeResolverOptions = {}): TicketResolver {
  async function* play(
    events: ResolverEvent[],
    signal: AbortSignal | undefined,
  ): AsyncGenerator<ResolverEvent> {
    for (const event of events) {
      await pause(stepDelayMs, signal);
      yield event;
    }
  }

  return {
    name: "fake",

    resolve({ signal }: ResolverRun) {
      const ending: ResolverEvent[] = propose
        ? [{ type: "interrupt", action: "apply_data_fix", args: { ...propose } }]
        : [{ type: "verdict", verdict: FAKE_VERDICT }];
      return play([...SCRIPT, ...ending], signal);
    },

    async *resume({ effects, signal }: ResolverRun, decision: ResolverDecision) {
      if (decision.decision === "reject") {
        yield* play([{ type: "verdict", verdict: rejectedVerdict(decision.reason ?? "") }], signal);
        return;
      }
      // Approved or edited: the write runs through the portal's own effect, exactly as the
      // real Resolver's tool would run it, and what it says goes onto the timeline.
      const settled =
        decision.proposal?.kind === "data_fix" ? decision.proposal.sql : (propose?.sql ?? "");
      const said = await effects.applyDataFix({ sql: settled, reason: propose?.reason ?? "" });
      yield* play(
        [
          { type: "tool_result", name: "apply_data_fix", result: said },
          { type: "verdict", verdict: fixedVerdict(said) },
        ],
        signal,
      );
    },
  };
}
