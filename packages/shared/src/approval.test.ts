import { describe, expect, it } from "vitest";
import {
  allowedDecisions,
  approvalActions,
  argumentsOf,
  isApprovalAction,
  permits,
  reviewerDecisionSchema,
} from "./approval";
import type { Proposal } from "./proposal";

describe("the gated actions", () => {
  it("is the three writes the agent cannot make on its own", () => {
    expect(approvalActions).toEqual([
      "apply_data_fix",
      "create_pull_request",
      "send_customer_reply",
    ]);
  });

  it("recognises a gated action by the name the tool call carries", () => {
    expect(isApprovalAction("apply_data_fix")).toBe(true);
    expect(isApprovalAction("run_readonly_sql")).toBe(false);
  });

  it("lets a data fix be approved, edited or rejected", () => {
    expect(allowedDecisions.apply_data_fix).toEqual(["approve", "edit", "reject"]);
  });

  it("lets a pull request only be approved or rejected", () => {
    expect(permits("create_pull_request", "approve")).toBe(true);
    expect(permits("create_pull_request", "reject")).toBe(true);
    expect(permits("create_pull_request", "edit")).toBe(false);
  });

  it("lets a Reply be approved or edited, never rejected", () => {
    expect(permits("send_customer_reply", "edit")).toBe(true);
    expect(permits("send_customer_reply", "reject")).toBe(false);
  });
});

describe("a Reviewer's Decision", () => {
  it("takes an approval with nothing else", () => {
    expect(reviewerDecisionSchema.parse({ decision: "approve" })).toEqual({ decision: "approve" });
  });

  it("takes an edit with the modified Proposal", () => {
    const edited = {
      decision: "edit",
      proposal: {
        kind: "data_fix",
        statement: "update",
        table: "shoplite.cart_totals",
        sql: "UPDATE shoplite.cart_totals SET total_cents = 1200 WHERE cart_id = '1'",
        reason: "The badge is stale",
        matchingRows: 1,
        executed: false,
      },
    };
    expect(reviewerDecisionSchema.parse(edited)).toMatchObject({ decision: "edit" });
  });

  it("refuses an edit with no Proposal, since there is then nothing to run", () => {
    expect(reviewerDecisionSchema.safeParse({ decision: "edit" }).success).toBe(false);
  });

  it("refuses a rejection with no reason, since the agent is told why", () => {
    expect(reviewerDecisionSchema.safeParse({ decision: "reject" }).success).toBe(false);
    expect(
      reviewerDecisionSchema.safeParse({ decision: "reject", reason: "Wrong cart" }).success,
    ).toBe(true);
  });
});

describe("the tool arguments a Proposal becomes", () => {
  it("hands a data fix back as the SQL and the reason the tool takes", () => {
    const proposal: Proposal = {
      kind: "data_fix",
      statement: "update",
      table: "shoplite.cart_totals",
      sql: "UPDATE shoplite.cart_totals SET total_cents = 1200 WHERE cart_id = '1'",
      reason: "The badge is stale",
      matchingRows: 1,
      executed: false,
    };
    expect(argumentsOf(proposal)).toEqual({ sql: proposal.sql, reason: proposal.reason });
  });

  it("hands a Reply back as its text", () => {
    expect(argumentsOf({ kind: "reply", text: "We have corrected it." })).toEqual({
      text: "We have corrected it.",
    });
  });

  it("hands a pull request back as its branch, title, body and files", () => {
    const proposal: Proposal = {
      kind: "pull_request",
      branch: "fix/ticket-1",
      title: "Apply the discount once",
      body: "Root cause…",
      files: ["src/domain/cart.ts"],
    };
    expect(argumentsOf(proposal)).toEqual({
      branch: "fix/ticket-1",
      title: "Apply the discount once",
      body: "Root cause…",
      files: ["src/domain/cart.ts"],
    });
  });
});
