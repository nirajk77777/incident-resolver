import { ESCALATION_REPLY, type Verdict } from "@incident-resolver/shared";
import { describe, expect, it } from "vitest";
import {
  endingWarnings,
  investigationWarnings,
  isFastPath,
  ranInParallel,
  settleVerdict,
} from "./policy";
import type { RunSummary } from "./run-summary";

const triage = {
  category: "question" as const,
  severity: "low" as const,
  component: "storefront" as const,
  hypothesis: "cache",
  confidence: 0.8,
  helpArticleIds: ["40000000-0000-4000-8000-000000000001"],
  bestHelpArticle: {
    id: "40000000-0000-4000-8000-000000000001",
    title: "Product images or pages not loading: clear your cache and hard refresh",
    body: "Hard refresh, then clear the cache.",
  },
};

describe("isFastPath", () => {
  it("takes the fast path for a Question with an article at or above the threshold", () => {
    expect(isFastPath(triage, 0.6)).toBe(true);
    expect(isFastPath({ ...triage, confidence: 0.6 }, 0.6)).toBe(true);
  });

  it("falls through below the threshold, without an article, or for another Category", () => {
    expect(isFastPath({ ...triage, confidence: 0.59 }, 0.6)).toBe(false);
    expect(isFastPath({ ...triage, helpArticleIds: [] }, 0.6)).toBe(false);
    expect(isFastPath({ ...triage, bestHelpArticle: null }, 0.6)).toBe(false);
    expect(isFastPath({ ...triage, category: "user_error" }, 0.6)).toBe(false);
  });
});

describe("settleVerdict", () => {
  const answered: Verdict = {
    outcome: "answered",
    category: "user_error",
    confidence: 0.9,
    rootCause: "The bank declined the card.",
    evidence: [{ fact: "gateway said insufficient_funds", provenance: "search_logs" }],
    reply: "Your card was declined.",
  };
  const confident = { confidenceThreshold: 0.6, escalationAsked: undefined };

  it("leaves a confident Verdict nobody escalated exactly as the Resolver wrote it", () => {
    expect(settleVerdict(answered, confident)).toBe(answered);
    expect(endingWarnings(answered, answered, confident)).toEqual([]);
  });

  it("escalates a run that asked for a human, whatever Outcome it then returned", () => {
    const ending = {
      confidenceThreshold: 0.6,
      escalationAsked: "the logs and the orders disagree",
    };
    const settled = settleVerdict(answered, ending);

    expect(settled.outcome).toBe("escalated");
    expect(settled.reply).toBe(ESCALATION_REPLY);
    // What the person picking it up reads: everything the run did establish.
    expect(settled.evidence).toEqual(answered.evidence);
    expect(settled.rootCause).toContain("The bank declined the card.");
    expect(settled.rootCause).toContain("the logs and the orders disagree");
    expect(endingWarnings(answered, settled, ending)).toEqual([
      "The Resolver called escalate_to_human and then returned answered: the Ticket was escalated",
    ]);
  });

  it("escalates a Verdict below the threshold, and says which rule did it", () => {
    const uncertain = { ...answered, confidence: 0.4 };
    const settled = settleVerdict(uncertain, confident);

    expect(settled.outcome).toBe("escalated");
    expect(endingWarnings(uncertain, settled, confident)).toEqual([
      "Confidence 0.4 is below the threshold 0.6, so the Ticket was escalated rather than closed as answered.",
    ]);
  });

  it("swaps in the holding Reply even when the run escalated itself, having asked", () => {
    // What the prompt asks for: call the tool, then return an escalated Verdict. The Reply the
    // model wrote is still not the one the Reporter reads, because a person writes that.
    const own: Verdict = {
      ...answered,
      outcome: "escalated",
      reply: "Here is what we think went wrong with your order.",
    };
    const settled = settleVerdict(own, {
      confidenceThreshold: 0.6,
      escalationAsked: "the logs and the orders disagree",
    });

    expect(settled.reply).toBe(ESCALATION_REPLY);
    expect(settled.rootCause).toContain("the logs and the orders disagree");
  });

  it("prefers the ask over the threshold, so the reason a run escalated is the one it gave", () => {
    const ending = { confidenceThreshold: 0.6, escalationAsked: "no Evidence either way" };
    expect(settleVerdict({ ...answered, confidence: 0.2 }, ending).rootCause).toContain(
      "no Evidence either way",
    );
  });
});

/** A run described by the turns that delegated, which is all these two rules read. */
const summary = (delegationTurns: string[][]): RunSummary => ({
  triage: undefined,
  subagentsInvoked: delegationTurns.flat(),
  subagentsReported: delegationTurns.flat(),
  delegationTurns,
});

describe("ranInParallel", () => {
  it("is true only when one turn asked for all three Investigators", () => {
    expect(
      ranInParallel(
        summary([["triage"], ["log-investigator", "data-investigator", "incident-historian"]]),
      ),
    ).toBe(true);
    expect(
      ranInParallel(summary([["log-investigator"], ["data-investigator"], ["incident-historian"]])),
    ).toBe(false);
    expect(ranInParallel(summary([["triage"]]))).toBe(false);
  });
});

describe("investigationWarnings", () => {
  it("says nothing about a fast-path run, which investigates nothing", () => {
    expect(investigationWarnings(summary([["triage"]]))).toEqual([]);
  });

  it("says nothing when all three were launched together", () => {
    expect(
      investigationWarnings(
        summary([["triage"], ["log-investigator", "data-investigator", "incident-historian"]]),
      ),
    ).toEqual([]);
  });

  it("names the Investigators a run skipped", () => {
    expect(investigationWarnings(summary([["triage"], ["data-investigator"]]))).toEqual([
      "The Resolver investigated without log-investigator and incident-historian: an investigated Ticket runs all three Investigators",
    ]);
  });

  it("reports three Investigators launched one turn at a time", () => {
    const warnings = investigationWarnings(
      summary([["triage"], ["log-investigator"], ["data-investigator"], ["incident-historian"]]),
    );
    expect(warnings).toEqual([
      "The three Investigators were launched in separate turns rather than one, so their spans do not overlap",
    ]);
  });
});
