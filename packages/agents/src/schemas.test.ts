import { describe, expect, it } from "vitest";
import { dataInvestigationSchema, triageSchema } from "./schemas";

const triage = {
  category: "question",
  severity: "low",
  component: "storefront",
  hypothesis: "Browser cache is serving pre-sale catalog assets.",
  confidence: 0.91,
  helpArticleIds: ["40000000-0000-4000-8000-000000000001"],
  bestHelpArticle: null,
};

describe("triageSchema", () => {
  it("accepts a Triage with a matching Help article", () => {
    expect(triageSchema.parse(triage)).toEqual(triage);
  });

  it("uses the six Categories from CONTEXT.md", () => {
    for (const category of [
      "question",
      "user_error",
      "data_issue",
      "code_bug",
      "infra",
      "unknown",
    ]) {
      expect(triageSchema.safeParse({ ...triage, category }).success).toBe(true);
    }
    expect(triageSchema.safeParse({ ...triage, category: "bug" }).success).toBe(false);
  });

  it("requires Help article ids to be uuids", () => {
    expect(triageSchema.safeParse({ ...triage, helpArticleIds: ["clear-cache"] }).success).toBe(
      false,
    );
  });
});

describe("dataInvestigationSchema", () => {
  it("accepts an Evidence summary with provenance and no Proposal", () => {
    const result = dataInvestigationSchema.parse({
      summary: "The latest payment for this customer was declined by the issuer.",
      evidence: [
        {
          fact: "payments row status=declined, decline_code=insufficient_funds, card ending 0002",
          provenance:
            "run_readonly_sql: SELECT status, decline_code FROM shoplite.payments WHERE customer_id = '...' ORDER BY created_at DESC LIMIT 5",
        },
      ],
      proposal: null,
    });
    expect(result.proposal).toBeNull();
  });

  it("carries a data fix Proposal untouched when the Investigator proposed one", () => {
    const proposal = {
      kind: "data_fix",
      statement: "update",
      table: "shoplite.cart_totals",
      sql: "UPDATE shoplite.cart_totals SET item_count = 1 WHERE cart_id = 'x'",
      reason: "cart_totals is stale after item removal",
      matchingRows: 1,
      executed: false,
    };
    const result = dataInvestigationSchema.parse({ summary: "s", evidence: [], proposal });
    expect(result.proposal).toEqual(proposal);
  });
});
