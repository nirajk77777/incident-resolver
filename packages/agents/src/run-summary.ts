import { AIMessage, type BaseMessage, ToolMessage } from "@langchain/core/messages";
import { type Triage, triageSchema } from "./schemas";

export type RunSummary = {
  /** Triage's structured output, when the Resolver delegated to it and it returned valid Triage. */
  triage: Triage | undefined;
  /** Every subagent the Resolver delegated to through the task tool, in order, repeats included. */
  subagentsInvoked: string[];
};

/**
 * Reads back what the Resolver did from its message history. Deep Agents' `task` tool carries
 * the subagent name in its arguments and returns the subagent's structured output as the
 * ToolMessage content, so the Triage result and the list of investigators that ran are both
 * recoverable without another model call.
 */
export function summarizeRun(messages: BaseMessage[]): RunSummary {
  const subagentByCallId = new Map<string, string>();
  const subagentsInvoked: string[] = [];
  let triage: Triage | undefined;

  for (const message of messages) {
    if (AIMessage.isInstance(message)) {
      for (const call of message.tool_calls ?? []) {
        const subagent = call.args.subagent_type;
        if (call.name !== "task" || typeof subagent !== "string") continue;
        subagentsInvoked.push(subagent);
        if (call.id) subagentByCallId.set(call.id, subagent);
      }
    } else if (ToolMessage.isInstance(message)) {
      if (triage === undefined && subagentByCallId.get(message.tool_call_id) === "triage") {
        triage = parseTriage(message.content);
      }
    }
  }

  return { triage, subagentsInvoked };
}

function parseTriage(content: BaseMessage["content"]): Triage | undefined {
  const text =
    typeof content === "string"
      ? content
      : content
          .map((block) => ("text" in block && typeof block.text === "string" ? block.text : ""))
          .join("");
  try {
    const parsed = triageSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
