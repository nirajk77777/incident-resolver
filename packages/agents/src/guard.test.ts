import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { createProcedureGuard, delegationRefusal } from "./guard";

const question = {
  category: "question",
  severity: "low",
  component: "storefront",
  hypothesis: "cache",
  confidence: 0.9,
  helpArticleIds: ["40000000-0000-4000-8000-000000000001"],
  bestHelpArticle: {
    id: "40000000-0000-4000-8000-000000000001",
    title: "Clear your cache",
    body: "Hard refresh.",
  },
};

const task = (subagent: string, id = "call") => ({
  id,
  name: "task",
  args: { description: "do it", subagent_type: subagent },
});

function afterTriage(triage: object) {
  return [
    new HumanMessage("ticket"),
    new AIMessage({ content: "", tool_calls: [task("triage", "t1")] }),
    new ToolMessage({ tool_call_id: "t1", name: "task", content: JSON.stringify(triage) }),
    new AIMessage({ content: "", tool_calls: [task("data-investigator", "d1")] }),
  ];
}

describe("delegationRefusal", () => {
  it("lets any tool other than task through", () => {
    expect(delegationRefusal({ name: "ls", args: {} }, [], 0.6)).toBeUndefined();
  });

  it("refuses a subagent that does not exist", () => {
    expect(delegationRefusal(task("general-purpose"), [], 0.6)).toMatch(
      /no subagent named general-purpose/,
    );
  });

  it("lets Triage run first and refuses it a second time", () => {
    expect(delegationRefusal(task("triage"), [new HumanMessage("ticket")], 0.6)).toBeUndefined();
    expect(delegationRefusal(task("triage"), afterTriage(question), 0.6)).toMatch(/already run/);
  });

  it("refuses the Data Investigator before Triage has run", () => {
    expect(delegationRefusal(task("data-investigator"), [new HumanMessage("ticket")], 0.6)).toMatch(
      /triage subagent first/,
    );
  });

  it("refuses the Data Investigator when the fast path applies", () => {
    expect(delegationRefusal(task("data-investigator"), afterTriage(question), 0.6)).toMatch(
      /fast path applies/,
    );
  });

  it("lets the Data Investigator run below the threshold or for another Category", () => {
    const lowConfidence = { ...question, confidence: 0.5 };
    expect(
      delegationRefusal(task("data-investigator"), afterTriage(lowConfidence), 0.6),
    ).toBeUndefined();
    const userError = {
      ...question,
      category: "user_error",
      helpArticleIds: [],
      bestHelpArticle: null,
    };
    expect(
      delegationRefusal(task("data-investigator"), afterTriage(userError), 0.6),
    ).toBeUndefined();
  });
});

describe("createProcedureGuard", () => {
  const guard = createProcedureGuard(0.6);

  it("answers a refused delegation with an error ToolMessage instead of running it", async () => {
    const messages = afterTriage(question);
    const request = {
      toolCall: task("data-investigator", "d1"),
      tool: undefined,
      state: { messages },
    };
    const handler = () => {
      throw new Error("must not run");
    };
    const reply = (await guard.wrapToolCall?.(request as never, handler as never)) as ToolMessage;
    expect(reply.tool_call_id).toBe("d1");
    expect(reply.status).toBe("error");
    expect(reply.content).toMatch(/Refused: the fast path applies/);
  });

  it("hands an allowed delegation to the real handler", async () => {
    const messages = [
      new HumanMessage("ticket"),
      new AIMessage({ content: "", tool_calls: [task("triage", "t1")] }),
    ];
    const request = { toolCall: task("triage", "t1"), tool: undefined, state: { messages } };
    const ran = new ToolMessage({ tool_call_id: "t1", name: "task", content: "{}" });
    const reply = await guard.wrapToolCall?.(request as never, (() => ran) as never);
    expect(reply).toBe(ran);
  });
});
