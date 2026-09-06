import type { BaseMessage } from "@langchain/core/messages";
import type { ToolCall } from "@langchain/core/messages/tool";
import { createMiddleware, ToolMessage } from "langchain";
import { isFastPath } from "./policy";
import { summarizeRun } from "./run-summary";
import { DATA_INVESTIGATOR, TRIAGE } from "./subagents";

/**
 * The Resolver's procedure, enforced in code rather than trusted to the prompt: Triage runs
 * first and once, only the declared subagents exist, and a Ticket that qualifies for the
 * fast path never reaches an Investigator. A refused delegation comes back to the model as a
 * tool error that says what to do instead, so the run continues rather than failing.
 */
export const resolverSubagents: readonly string[] = [TRIAGE, DATA_INVESTIGATOR];

/** Why a task tool call must not run, or undefined when it may. Pure, for tests. */
export function delegationRefusal(
  toolCall: ToolCall,
  messages: BaseMessage[],
  confidenceThreshold: number,
): string | undefined {
  if (toolCall.name !== "task") return undefined;
  const subagent = toolCall.args.subagent_type;
  if (typeof subagent !== "string" || !resolverSubagents.includes(subagent)) {
    return `there is no subagent named ${String(subagent)}; the only subagents are ${resolverSubagents.join(" and ")}`;
  }
  const { triage } = summarizeRun(messages);
  if (subagent === TRIAGE && triage) {
    return "Triage has already run for this Ticket; use its result instead of running it again";
  }
  if (subagent === DATA_INVESTIGATOR) {
    if (!triage) return "run the triage subagent first; investigators only run after Triage";
    if (isFastPath(triage, confidenceThreshold)) {
      return (
        "the fast path applies: Triage found a Help article at or above the Confidence threshold, " +
        "so write the Reply from bestHelpArticle with outcome answered and do not investigate"
      );
    }
  }
  return undefined;
}

export function createProcedureGuard(confidenceThreshold: number) {
  return createMiddleware({
    name: "procedure-guard",
    wrapToolCall: (request, handler) => {
      const reason = delegationRefusal(
        request.toolCall,
        request.state.messages,
        confidenceThreshold,
      );
      if (reason === undefined) return handler(request);
      return new ToolMessage({
        tool_call_id: request.toolCall.id ?? "",
        name: request.toolCall.name,
        content: `Refused: ${reason}.`,
        status: "error",
      });
    },
  });
}
