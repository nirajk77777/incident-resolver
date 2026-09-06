import type { Verdict } from "@incident-resolver/shared";
import { ESCALATION_REPLY } from "@incident-resolver/shared";
import { describe, expect, it } from "vitest";
import { applyConfidencePolicy, investigationWarnings, isFastPath, ranInParallel } from "./policy";
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

describe("applyConfidencePolicy", () => {
  const verdict: Verdict = {
    outcome: "answered",
    category: "user_error",
    confidence: 0.4,
    rootCause: "Probably a declined card, but the payments table was empty.",
    evidence: [],
    reply: "Your card was declined.",
  };

  it("escalates a Verdict whose Confidence is below the threshold and swaps in the holding Reply", () => {
    const result = applyConfidencePolicy(verdict, 0.6);
    expect(result.outcome).toBe("escalated");
    expect(result.reply).toBe(ESCALATION_REPLY);
    expect(result.rootCause).toBe(verdict.rootCause);
    expect(result.confidence).toBe(0.4);
  });

  it("leaves a confident Verdict alone", () => {
    const confident = { ...verdict, confidence: 0.6 };
    expect(applyConfidencePolicy(confident, 0.6)).toBe(confident);
  });

  it("leaves an already escalated Verdict's Reply alone", () => {
    const escalated: Verdict = {
      ...verdict,
      outcome: "escalated",
      reply: "We are looking into it.",
    };
    expect(applyConfidencePolicy(escalated, 0.6)).toBe(escalated);
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
