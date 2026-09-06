import { describe, expect, it } from "vitest";
import { createScoreWriter, noScores, outcomeValue } from "./scores";

describe("what an Outcome scores as", () => {
  it("is resolved when the agent finished the Ticket itself", () => {
    expect(outcomeValue("answered")).toBe("resolved");
    expect(outcomeValue("data_fixed")).toBe("resolved");
    expect(outcomeValue("fix_proposed")).toBe("resolved");
  });

  it("is escalated when it handed the Ticket to a person", () => {
    expect(outcomeValue("escalated")).toBe("escalated");
  });
});

describe("a portal with no Langfuse keys", () => {
  it("writes no scores rather than failing a Decision", async () => {
    const scores = createScoreWriter({ publicKey: undefined, secretKey: undefined });
    expect(scores).toBe(noScores);
    scores.decision("trace", { action: "apply_data_fix", decision: "approve" });
    scores.outcome("trace", "data_fixed");
    await expect(scores.flush()).resolves.toBeUndefined();
  });
});
