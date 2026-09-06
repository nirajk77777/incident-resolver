import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { StructuredTool } from "@langchain/core/tools";
import { tool } from "langchain";
import { z } from "zod";

/**
 * The Resolver's way of asking for a human before it has anything to write. It is not a gated
 * action and nothing is proposed: an escalation costs the Reporter a wait, not a change to
 * their data, so it needs no Reviewer to let it through.
 *
 * Calling it is what makes the escalation binding. The run still returns a Verdict, but the
 * Outcome no longer rests on what the model then wrote in it: a run that asked for a human is
 * escalated whatever its Verdict says, the same way Confidence below the threshold is.
 */
export const ESCALATE_TO_HUMAN = "escalate_to_human";

const escalateArgs = z.object({
  reason: z
    .string()
    .min(1)
    .describe(
      "Why this needs a person: which Evidence conflicts, or what could not be established",
    ),
});

export function createEscalationTool(): StructuredTool {
  return tool(
    async ({ reason }: z.infer<typeof escalateArgs>) =>
      `Recorded: ${reason}\n\nThis Ticket now goes to a human whatever you return, and the ` +
      "Reporter gets the holding message rather than your Reply. Finish now: return the Verdict " +
      "with outcome escalated, the root cause as far as you established it, and every piece of " +
      "Evidence you gathered, so the person picking it up starts from what you found.",
    {
      name: ESCALATE_TO_HUMAN,
      description:
        "Hands the Ticket to a human. Call it when the Evidence conflicts, when what you found " +
        "does not explain what the Reporter saw, or when the fix is one you cannot make. Nothing " +
        "is written and the Reporter is told a person is looking into it. Call it once, then " +
        "return your Verdict.",
      schema: escalateArgs,
    },
  );
}

/**
 * Why the run asked for a human, or undefined when it never did. Read back off the message
 * history rather than remembered in a closure, so it survives the run pausing at the approval
 * gate and being resumed from the checkpoint minutes later.
 */
export function escalationRequested(messages: BaseMessage[]): string | undefined {
  for (const message of messages) {
    if (!AIMessage.isInstance(message)) continue;
    for (const call of message.tool_calls ?? []) {
      if (call.name !== ESCALATE_TO_HUMAN) continue;
      const reason = call.args.reason;
      return typeof reason === "string" && reason.trim().length > 0
        ? reason.trim()
        : "no reason given";
    }
  }
  return undefined;
}
