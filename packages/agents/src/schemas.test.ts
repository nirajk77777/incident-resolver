import { describe, expect, it } from "vitest";
import {
  codeRcaSchema,
  dataInvestigationSchema,
  incidentSearchSchema,
  logInvestigationSchema,
  triageSchema,
} from "./schemas";

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

describe("logInvestigationSchema", () => {
  const investigation = {
    summary: "The checkout request failed with a 402 from the mock gateway.",
    evidence: [
      {
        fact: "payment declined: insufficient_funds, card ending 0002",
        provenance:
          'search_logs {service_name="shoplite-api"} | trace_id="4bf92f3577b34da6a3ce929d0e0e4736" at 2026-09-06T09:12:03Z',
      },
    ],
    traceIds: ["4bf92f3577b34da6a3ce929d0e0e4736"],
    errorRate: null,
  };

  it("accepts Evidence with the trace ids the run can link the Ticket to", () => {
    expect(logInvestigationSchema.parse(investigation)).toEqual(investigation);
  });

  it("rejects a trace id that is not 32 hex characters", () => {
    expect(
      logInvestigationSchema.safeParse({ ...investigation, traceIds: ["not-a-trace"] }).success,
    ).toBe(false);
  });
});

describe("incidentSearchSchema", () => {
  it("carries each match with its documented resolution and rerank score", () => {
    const result = incidentSearchSchema.parse({
      summary: "One past Incident documents the same stale cart_totals row.",
      matches: [
        {
          id: "30000000-0000-4000-8000-000000000001",
          title: "Cart tag shows a stale item count and total after removing an item",
          rootCause: "removeItem does not refresh the denormalised cart_totals row",
          resolution:
            "UPDATE shoplite.cart_totals SET item_count = ... WHERE cart_id = '<cart id>'",
          relevanceScore: 0.94,
        },
      ],
      evidence: [
        {
          fact: "A March Incident describes the same symptom and documents the recompute UPDATE",
          provenance: "search_similar_incidents: incident 30000000-0000-4000-8000-000000000001",
        },
      ],
    });
    expect(result.matches[0]?.relevanceScore).toBe(0.94);
  });

  it("accepts an empty match list rather than forcing a near miss", () => {
    const result = incidentSearchSchema.parse({
      summary: "No past Incident matches this Ticket.",
      matches: [],
      evidence: [],
    });
    expect(result.matches).toEqual([]);
  });
});

const rca = {
  rootCause:
    "finalizeOrder discounts a subtotal calculateSubtotal has already discounted, so a percent code comes off twice.",
  file: "apps/api/src/domain/order.ts",
  line: 20,
  failingTest: {
    file: "apps/api/src/domain/order.test.ts",
    name: "takes a percentage code off exactly once",
  },
  patch: {
    files: ["apps/api/src/domain/order.ts"],
    summary: "Price the order from the undiscounted subtotal and take the discount off once.",
  },
  testsGreen: true,
};

describe("codeRcaSchema", () => {
  it("accepts an RCA that names the file, the line, the failing test, and a green suite", () => {
    expect(codeRcaSchema.parse(rca)).toEqual(rca);
  });

  it("takes a line number or nothing, but never a line that does not exist", () => {
    expect(codeRcaSchema.safeParse({ ...rca, line: 0 }).success).toBe(false);
    const { line, ...withoutLine } = rca;
    expect(codeRcaSchema.safeParse(withoutLine).success).toBe(false);
  });

  it("insists a patch that exists names the files it touched", () => {
    expect(codeRcaSchema.safeParse({ ...rca, patch: { ...rca.patch, files: [] } }).success).toBe(
      false,
    );
  });

  it("lets Code RCA report that it could not find the cause, rather than inventing one", () => {
    const gaveUp = {
      rootCause:
        "The Evidence points at the checkout route, but the total it returns is computed in a module I could not find; I changed nothing.",
      file: null,
      line: null,
      failingTest: null,
      patch: null,
      testsGreen: false,
    };

    expect(codeRcaSchema.parse(gaveUp)).toEqual(gaveUp);
  });
});
