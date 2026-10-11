import type { ActionRequest } from "langchain";
import { describe, expect, it } from "vitest";
import { decisionsFor } from "./agent-resolver";
import type { ResolverDecision } from "./resolver";

const dataFix: ActionRequest = {
  name: "apply_data_fix",
  args: { sql: "UPDATE shoplite.cart_totals SET item_count = 1 WHERE cart_id = '1'", reason: "r" },
};
const reply: ActionRequest = { name: "send_customer_reply", args: { text: "We fixed it" } };

const approve: ResolverDecision = { action: "apply_data_fix", decision: "approve" };

describe("answering what the gate is holding", () => {
  it("gives the Reviewer's answer to the Proposal they answered", () => {
    expect(decisionsFor([dataFix], approve)).toEqual([{ type: "approve" }]);
  });

  it("carries an edit through as the arguments the tool then runs on", () => {
    const [answer] = decisionsFor([dataFix], {
      action: "apply_data_fix",
      decision: "edit",
      proposal: {
        kind: "data_fix",
        statement: "update",
        table: "shoplite.cart_totals",
        sql: "UPDATE shoplite.cart_totals SET item_count = 2 WHERE cart_id = '1'",
        reason: "Two lines",
        matchingRows: 1,
        executed: false,
      },
    });

    expect(answer).toEqual({
      type: "edit",
      editedAction: {
        name: "apply_data_fix",
        args: {
          sql: "UPDATE shoplite.cart_totals SET item_count = 2 WHERE cart_id = '1'",
          reason: "Two lines",
        },
      },
    });
  });

  it("carries a rejection through as the reason the agent reads", () => {
    expect(
      decisionsFor([dataFix], {
        action: "apply_data_fix",
        decision: "reject",
        reason: "The wrong cart",
      }),
    ).toEqual([{ type: "reject", message: "The wrong cart" }]);
  });

  /**
   * The graph reads one Decision per Proposal, so a short array would strand the run on the
   * thread. A Reviewer only ever saw one of them, so the rest cannot be let through.
   */
  it("answers every Proposal of the turn, refusing the ones nobody saw", () => {
    const answers = decisionsFor([dataFix, reply], approve);

    expect(answers).toHaveLength(2);
    expect(answers[0]).toEqual({ type: "approve" });
    expect(answers[1]).toMatchObject({ type: "reject" });
    expect((answers[1] as { message: string }).message).toMatch(/on its own/);
  });

  it("answers the first Proposal for that action, and refuses a second of the same kind", () => {
    const answers = decisionsFor([dataFix, dataFix], approve);

    expect(answers[0]).toEqual({ type: "approve" });
    expect(answers[1]).toMatchObject({ type: "reject" });
  });
});
