import type { Verdict } from "@incident-resolver/shared";
import type { ResolverEvent, ResolverRun, TicketResolver } from "./resolver";

/**
 * The Verdict the fake always reaches: demo moment one, a card the mock gateway declines
 * because it ends in 0002, answered from what the logs say the gateway replied.
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

/**
 * A Resolver that investigates nothing and always reaches the same Verdict. It exists so
 * the whole Ticket lifecycle — timeline, SSE, Outcome, Reply — is testable over HTTP with
 * no model behind it. The real Resolver plugs into the same seam.
 */
export function createFakeResolver({ stepDelayMs = 0 }: FakeResolverOptions = {}): TicketResolver {
  return {
    name: "fake",
    async *resolve({ signal }: ResolverRun) {
      for (const event of [...SCRIPT, { type: "verdict", verdict: FAKE_VERDICT } as const]) {
        await pause(stepDelayMs, signal);
        yield event;
      }
    },
  };
}
