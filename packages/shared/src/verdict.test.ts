import { describe, expect, it } from "vitest";
import { outcomes, verdictSchema } from "./verdict";

const verdict = {
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
