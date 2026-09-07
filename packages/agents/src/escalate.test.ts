import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { createEscalationTool, ESCALATE_TO_HUMAN, escalationRequested } from "./escalate";

const asked = (reason: unknown) =>
  new AIMessage({
    content: "",
    tool_calls: [{ id: "call-1", name: ESCALATE_TO_HUMAN, args: { reason } }],
  });

describe("the escalation tool", () => {
  it("is ungated: it writes nothing, so it takes no effects and needs no Reviewer", async () => {
    const escalate = createEscalationTool();
    expect(escalate.name).toBe(ESCALATE_TO_HUMAN);
    const said = await escalate.invoke({ reason: "The logs and the orders table disagree" });
    expect(said).toContain("The logs and the orders table disagree");
    expect(said).toContain("outcome escalated");
  });
});

describe("escalationRequested", () => {
  it("reads the reason back off the run's messages", () => {
    const messages = [
      new HumanMessage("Checkout failed"),
      asked("The logs and the orders table disagree"),
      new ToolMessage({ content: "Recorded", tool_call_id: "call-1" }),
    ];
    expect(escalationRequested(messages)).toBe("The logs and the orders table disagree");
  });

  it("is undefined for a run that never asked", () => {
    expect(escalationRequested([new HumanMessage("Checkout failed")])).toBeUndefined();
    expect(
      escalationRequested([
        new AIMessage({
          content: "",
          tool_calls: [{ id: "call-2", name: "send_customer_reply", args: { text: "Hi" } }],
        }),
      ]),
    ).toBeUndefined();
  });

  it("still reports the escalation when the model gave no usable reason", () => {
    expect(escalationRequested([asked("  ")])).toBe("no reason given");
    expect(escalationRequested([asked(undefined)])).toBe("no reason given");
  });

  it("takes the first ask, so a run that asked twice reads as one escalation", () => {
    expect(escalationRequested([asked("first"), asked("second")])).toBe("first");
  });
});
