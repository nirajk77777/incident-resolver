import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { summarizeRun } from "./run-summary";

const triage = {
  category: "user_error",
  severity: "medium",
  component: "payments",
  hypothesis: "The card was declined by the gateway.",
  confidence: 0.7,
  helpArticleIds: [],
  bestHelpArticle: null,
};

describe("summarizeRun", () => {
  it("finds the Triage output and every subagent the Resolver delegated to", () => {
    const messages = [
      new HumanMessage("ticket"),
      new AIMessage({
        content: "",
        tool_calls: [
          { id: "call_1", name: "task", args: { description: "triage", subagent_type: "triage" } },
        ],
      }),
      new ToolMessage({ tool_call_id: "call_1", name: "task", content: JSON.stringify(triage) }),
      new AIMessage({
        content: "",
        tool_calls: [
          {
            id: "call_2",
            name: "task",
            args: { description: "check payments", subagent_type: "data-investigator" },
          },
        ],
      }),
      new ToolMessage({
        tool_call_id: "call_2",
        name: "task",
        content: JSON.stringify({ summary: "declined", evidence: [], proposal: null }),
      }),
      new AIMessage("done"),
    ];

    expect(summarizeRun(messages)).toEqual({
      triage,
      subagentsInvoked: ["triage", "data-investigator"],
    });
  });

  it("reports no Triage and no subagents when the Resolver never delegated", () => {
    expect(summarizeRun([new HumanMessage("ticket"), new AIMessage("done")])).toEqual({
      triage: undefined,
      subagentsInvoked: [],
    });
  });

  it("ignores a Triage tool result that is not valid Triage output", () => {
    const messages = [
      new AIMessage({
        content: "",
        tool_calls: [
          { id: "c", name: "task", args: { description: "t", subagent_type: "triage" } },
        ],
      }),
      new ToolMessage({ tool_call_id: "c", name: "task", content: "Task completed" }),
    ];
    expect(summarizeRun(messages)).toEqual({ triage: undefined, subagentsInvoked: ["triage"] });
  });
});
