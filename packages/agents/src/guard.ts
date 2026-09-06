import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ToolCall } from "@langchain/core/messages/tool";
import { createMiddleware, ToolMessage } from "langchain";
import { isFastPath } from "./policy";
import { summarizeRun } from "./run-summary";
import type { Triage } from "./schemas";
import { investigators, TRIAGE } from "./subagents";

/**
 * The Resolver's procedure, enforced in code rather than trusted to the prompt: Triage runs
 * first and once, only the declared subagents exist, each runs at most once, a Ticket that
 * qualifies for the fast path never reaches an Investigator, and every Investigator that does
 * run is handed Triage's hypothesis as focus. A refused delegation comes back to the model as
 * a tool error that says what to do instead, so the run continues rather than failing.
 */
export const resolverSubagents: readonly string[] = [TRIAGE, ...investigators];

/** What the guard decided about one tool call, and the Triage it read on the way. */
export type Delegation = {
  /** Why the call must not run, or undefined when it may. */
  refusal: string | undefined;
  /** Triage's result, when it had already returned one by this point in the run. */
  triage: Triage | undefined;
};

/** Whether a task tool call may run, and the Triage to focus it with. Pure, for tests. */
export function judgeDelegation(
  toolCall: ToolCall,
  messages: BaseMessage[],
  confidenceThreshold: number,
): Delegation {
  const { triage, subagentsInvoked } = delegationsBefore(toolCall, messages);
  const refusal = refuse(toolCall, triage, subagentsInvoked, confidenceThreshold);
  return { refusal, triage };
}

/** Why a task tool call must not run, or undefined when it may. */
export function delegationRefusal(
  toolCall: ToolCall,
  messages: BaseMessage[],
  confidenceThreshold: number,
): string | undefined {
  return judgeDelegation(toolCall, messages, confidenceThreshold).refusal;
}

function refuse(
  toolCall: ToolCall,
  triage: Triage | undefined,
  subagentsInvoked: string[],
  confidenceThreshold: number,
): string | undefined {
  if (toolCall.name !== "task") return undefined;
  const subagent = toolCall.args.subagent_type;
  if (typeof subagent !== "string" || !resolverSubagents.includes(subagent)) {
    return `there is no subagent named ${String(subagent)}; the only subagents are ${resolverSubagents.join(", ")}`;
  }
  if (subagent === TRIAGE) {
    return triage || subagentsInvoked.includes(TRIAGE)
      ? "Triage has already run for this Ticket; use its result instead of running it again"
      : undefined;
  }
  if (!triage) return "run the triage subagent first; investigators only run after Triage";
  if (isFastPath(triage, confidenceThreshold)) {
    return (
      "the fast path applies: Triage found a Help article at or above the Confidence threshold, " +
      "so write the Reply from bestHelpArticle with outcome answered and do not investigate"
    );
  }
  if (subagentsInvoked.includes(subagent)) {
    return `the ${subagent} subagent has already run for this Ticket; use the Evidence it returned`;
  }
  return undefined;
}

function isInvestigator(subagent: unknown): boolean {
  return typeof subagent === "string" && (investigators as readonly string[]).includes(subagent);
}

/**
 * The heading this appends under. Matched in full, including the markdown prefix: the Resolver
 * writes the words "Triage hypothesis" into its own briefs, and a looser check would read that
 * as the focus already being there and skip appending it.
 */
export const FOCUS_HEADING = "## Triage hypothesis (focus, not a filter)";

/**
 * Hands an Investigator Triage's hypothesis as focus. Appended here rather than left to the
 * Resolver to copy, so all three Investigators are focused by the same words, and worded so
 * the hypothesis narrows where an Investigator looks first without licensing it to stop.
 */
export function withTriageFocus(toolCall: ToolCall, triage: Triage | undefined): ToolCall {
  const subagent = toolCall.args.subagent_type;
  if (!triage || !isInvestigator(subagent)) return toolCall;
  const description =
    typeof toolCall.args.description === "string" ? toolCall.args.description : "";
  if (description.includes(FOCUS_HEADING)) return toolCall;
  const focus = [
    description,
    "",
    FOCUS_HEADING,
    "",
    `Triage called this a ${triage.category} in ${triage.component}: ${triage.hypothesis}`,
    "",
    "That is where to look first, not a reason to stop: investigate your own source in full and " +
      "report what it shows even when it contradicts the hypothesis or says nothing at all.",
  ].join("\n");
  return { ...toolCall, args: { ...toolCall.args, description: focus } };
}

export function createProcedureGuard(confidenceThreshold: number) {
  return createMiddleware({
    name: "procedure-guard",
    wrapToolCall: (request, handler) => {
      const { refusal, triage } = judgeDelegation(
        request.toolCall,
        request.state.messages,
        confidenceThreshold,
      );
      if (refusal !== undefined) {
        return new ToolMessage({
          tool_call_id: request.toolCall.id ?? "",
          name: request.toolCall.name,
          content: `Refused: ${refusal}.`,
          status: "error",
        });
      }
      return handler({ ...request, toolCall: withTriageFocus(request.toolCall, triage) });
    },
  });
}

/**
 * What the run had already delegated to when this tool call was made.
 *
 * A tool call is wrapped with its own AI message already in state, so a fan-out would
 * otherwise see its two siblings, and itself, as having already run. Earlier turns are
 * therefore taken whole, and from the call's own turn only the calls that precede it — which
 * is what stops one turn asking for the same Investigator twice. Triage is read from the
 * earlier turns alone: a result cannot exist yet for a call in the current one.
 */
function delegationsBefore(
  toolCall: ToolCall,
  messages: BaseMessage[],
): { triage: Triage | undefined; subagentsInvoked: string[] } {
  const turn = toolCall.id
    ? messages.findIndex(
        (message) =>
          AIMessage.isInstance(message) &&
          (message.tool_calls ?? []).some((call) => call.id === toolCall.id),
      )
    : -1;
  if (turn === -1) return summarizeRun(messages);

  const before = summarizeRun(messages.slice(0, turn));
  const own = messages[turn] as AIMessage;
  const earlierInTurn = (own.tool_calls ?? [])
    .slice(
      0,
      (own.tool_calls ?? []).findIndex((call) => call.id === toolCall.id),
    )
    .filter((call) => call.name === "task")
    .map((call) => call.args.subagent_type)
    .filter((name): name is string => typeof name === "string");

  return {
    triage: before.triage,
    subagentsInvoked: [...before.subagentsInvoked, ...earlierInTurn],
  };
}
