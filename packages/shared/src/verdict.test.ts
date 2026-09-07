import { describe, expect, it } from "vitest";
import {
  applyConfidencePolicy,
  belowThresholdReason,
  ESCALATION_REPLY,
  escalated,
  outcomes,
  type Verdict,
  verdictSchema,
} from "./verdict";

const verdict: Verdict = {
  outcome: "answered",
  category: "question",
  confidence: 0.92,
  rootCause: "The browser is showing a cached copy of the catalog from before the sale.",
  evidence: [
    {
      fact: "Help article 'Product images or pages not loading' matches with relevance 0.92",
      provenance: "search_help_articles: 'product images not loading after sale'",
    },
  ],
  reply: "Hi Ava, please try a hard refresh (Cmd+Shift+R) and then clear your browser cache.",
};

describe("verdictSchema", () => {
  it("lists the four Outcomes from CONTEXT.md", () => {
    expect(outcomes).toEqual(["answered", "data_fixed", "fix_proposed", "escalated"]);
  });

  it("accepts a complete Verdict", () => {
    expect(verdictSchema.parse(verdict)).toEqual(verdict);
  });

  it("rejects an Outcome or Category outside the vocabulary", () => {
    expect(verdictSchema.safeParse({ ...verdict, outcome: "resolved" }).success).toBe(false);
    expect(verdictSchema.safeParse({ ...verdict, category: "billing" }).success).toBe(false);
  });

  it("keeps Confidence between 0 and 1", () => {
    expect(verdictSchema.safeParse({ ...verdict, confidence: 1.2 }).success).toBe(false);
    expect(verdictSchema.safeParse({ ...verdict, confidence: -0.1 }).success).toBe(false);
  });

  it("requires every Evidence reference to carry provenance", () => {
    const result = verdictSchema.safeParse({ ...verdict, evidence: [{ fact: "x" }] });
    expect(result.success).toBe(false);
  });

  it("requires a Reply", () => {
    expect(verdictSchema.safeParse({ ...verdict, reply: "" }).success).toBe(false);
  });
});

describe("applyConfidencePolicy", () => {
  const uncertain = {
    ...verdict,
    confidence: 0.4,
    rootCause: "Probably a declined card, but the payments table was empty.",
    reply: "Your card was declined.",
  };

  it("escalates a Verdict below the threshold and swaps in the holding Reply", () => {
    const result = applyConfidencePolicy(uncertain, 0.6);
    expect(result.outcome).toBe("escalated");
    expect(result.reply).toBe(ESCALATION_REPLY);
    expect(result.rootCause).toBe(uncertain.rootCause);
    expect(result.confidence).toBe(0.4);
  });

  it("leaves a confident Verdict alone", () => {
    const confident = { ...uncertain, confidence: 0.6 };
    expect(applyConfidencePolicy(confident, 0.6)).toBe(confident);
  });

  it("leaves an already escalated Verdict's own Reply alone: it chose to hand the Ticket over", () => {
    const already = {
      ...uncertain,
      outcome: "escalated" as const,
      reply: "We are looking into it.",
    };
    expect(applyConfidencePolicy(already, 0.6)).toBe(already);
  });
});

describe("escalated", () => {
  it("keeps the Evidence and the root cause, and appends the note", () => {
    const result = escalated(verdict, "The Resolver asked for a human.");
    expect(result.outcome).toBe("escalated");
    expect(result.reply).toBe(ESCALATION_REPLY);
    expect(result.evidence).toEqual(verdict.evidence);
    expect(result.rootCause).toBe(`${verdict.rootCause} The Resolver asked for a human.`);
  });

  it("swaps the Reply even on a Verdict that already said escalated", () => {
    const wordy: Verdict = {
      ...verdict,
      outcome: "escalated",
      reply: "Here is exactly what went wrong with your order and what we changed.",
    };
    expect(escalated(wordy).reply).toBe(ESCALATION_REPLY);
  });
});

describe("belowThresholdReason", () => {
  it("says which rule sent the Ticket to a person, and what it would otherwise have closed as", () => {
    expect(belowThresholdReason({ ...verdict, confidence: 0.4 }, 0.6)).toBe(
      "Confidence 0.4 is below the threshold 0.6, so the Ticket was escalated rather than closed as answered.",
    );
  });
});
