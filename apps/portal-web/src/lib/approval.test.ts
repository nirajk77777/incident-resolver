import { describe, expect, it } from "vitest";
import { columnsOf, editedProposalFor, isEditable } from "./approval";
import type { Approval, Proposal } from "./tickets";
import { pendingApproval } from "./tickets";

const dataFix: Proposal = {
  kind: "data_fix",
  statement: "update",
  table: "shoplite.cart_totals",
  sql: "UPDATE shoplite.cart_totals SET item_count = 1 WHERE cart_id = '1'",
  reason: "The badge is stale",
  matchingRows: 1,
  executed: false,
};

const approval = (over: Partial<Approval> = {}): Approval => ({
  id: "a1",
  run: 1,
  action: "apply_data_fix",
  allowedDecisions: ["approve", "edit", "reject"],
  proposal: dataFix,
  preview: null,
  decision: null,
  editedProposal: null,
  reason: null,
  result: null,
  createdAt: "2026-09-06T10:00:00.000Z",
  decidedAt: null,
  executedAt: null,
  ...over,
});

describe("the Proposal a Reviewer is being asked about", () => {
  it("is the undecided one", () => {
    const decided = approval({ id: "a0", decision: "approve" });
    expect(pendingApproval([decided, approval()])?.id).toBe("a1");
  });

  it("is none once every Proposal has been decided", () => {
    expect(pendingApproval([approval({ decision: "reject" })])).toBeUndefined();
  });
});

describe("what a card lets a Reviewer change", () => {
  it("lets a data fix and a Reply be edited", () => {
    expect(isEditable(approval())).toBe(true);
    expect(
      isEditable(
        approval({
          action: "send_customer_reply",
          allowedDecisions: ["approve", "edit"],
          proposal: { kind: "reply", text: "We fixed it" },
        }),
      ),
    ).toBe(true);
  });

  it("leaves a pull request as approve or reject", () => {
    expect(
      isEditable(
        approval({
          action: "create_pull_request",
          allowedDecisions: ["approve", "reject"],
          proposal: { kind: "pull_request", branch: "f", title: "t", body: "b", files: [] },
        }),
      ),
    ).toBe(false);
  });
});

describe("the edited Proposal a card sends", () => {
  it("carries the Reviewer's SQL back in the Proposal's own shape", () => {
    const edited = editedProposalFor(dataFix, "UPDATE shoplite.cart_totals SET item_count = 2");
    expect(edited).toMatchObject({
      kind: "data_fix",
      sql: "UPDATE shoplite.cart_totals SET item_count = 2",
      reason: dataFix.reason,
    });
  });

  it("carries the Reviewer's wording of a Reply", () => {
    expect(editedProposalFor({ kind: "reply", text: "before" }, "after")).toEqual({
      kind: "reply",
      text: "after",
    });
  });

  it("leaves a pull request alone, since a Reviewer never rewrites one", () => {
    const pr: Proposal = { kind: "pull_request", branch: "f", title: "t", body: "b", files: [] };
    expect(editedProposalFor(pr, "anything")).toEqual(pr);
  });
});

describe("the preview table", () => {
  it("takes its columns from the rows, in the order the first row has them", () => {
    expect(
      columnsOf([
        { cart_id: "1", item_count: 4 },
        { cart_id: "2", item_count: 1, total_cents: 900 },
      ]),
    ).toEqual(["cart_id", "item_count", "total_cents"]);
  });

  it("is empty when nothing matched", () => {
    expect(columnsOf([])).toEqual([]);
  });
});
