import { AIMessage, type BaseMessage, ToolMessage } from "@langchain/core/messages";
import { type Triage, triageSchema } from "./schemas";

export type RunSummary = {
  /** Triage's structured output, when the Resolver delegated to it and it returned valid Triage. */
  triage: Triage | undefined;
  /** Every subagent the Resolver delegated to through the task tool, in order, repeats included. */
  subagentsInvoked: string[];
  /**
   * The subagents that have answered, in the order their results came back. A subagent that was
   * launched is not one that has reported: a fan-out is invoked three deep and reported none,
   * which is the difference between a delegation being under way and its Evidence being in.
   */
  subagentsReported: string[];
  /**
   * The subagents named by each model turn that delegated, in order. A fan-out is one turn
   * holding several names: that is what makes their spans run, and appear in Langfuse, at once.
   */
  delegationTurns: string[][];
};

/**
 * Reads back what the Resolver did from its message history. Deep Agents' `task` tool carries
 * the subagent name in its arguments and returns the subagent's structured output as the
 * ToolMessage content, so the Triage result, the list of investigators that ran, and whether
 * they were launched together are all recoverable without another model call.
 */
export function summarizeRun(messages: BaseMessage[]): RunSummary {
  const subagentByCallId = new Map<string, string>();
  const subagentsInvoked: string[] = [];
  const subagentsReported: string[] = [];
  const delegationTurns: string[][] = [];
  let triage: Triage | undefined;

  for (const message of messages) {
    if (AIMessage.isInstance(message)) {
      const turn: string[] = [];
      for (const call of message.tool_calls ?? []) {
        const subagent = call.args.subagent_type;
        if (call.name !== "task" || typeof subagent !== "string") continue;
        turn.push(subagent);
        subagentsInvoked.push(subagent);
        if (call.id) subagentByCallId.set(call.id, subagent);
      }
      if (turn.length > 0) delegationTurns.push(turn);
    } else if (ToolMessage.isInstance(message)) {
      const answered = subagentByCallId.get(message.tool_call_id);
      if (answered === undefined) continue;
      subagentsReported.push(answered);
      if (triage === undefined && answered === "triage") triage = parseTriage(message.content);
    }
  }

  return { triage, subagentsInvoked, subagentsReported, delegationTurns };
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
