import type { StructuredTool } from "@langchain/core/tools";
import { tool } from "langchain";
import { z } from "zod";

/**
 * The Resolver's three write tools, and the only ones it has. Everything else the Resolver and
 * its subagents can reach reads. Each of these is a gated action (PLAN.md section 5): the graph
 * is interrupted before it runs, the Proposal goes to a Reviewer, and the tool runs only on a
 * Decision — so the tool body itself is the approved write, not a proposal of one.
 *
 * What the write actually does is injected: the portal supplies effects that run the fix
 * through the writing role and record the Reply, and the command line supplies effects that
 * write nothing. The agent package never touches ShopLite data itself.
 */

export const APPLY_DATA_FIX = "apply_data_fix";
export const SEND_CUSTOMER_REPLY = "send_customer_reply";

export type DataFixRequest = {
  /** One UPDATE or DELETE with a WHERE clause on a ShopLite table. */
  sql: string;
  /** Why this fix is right, with the Evidence behind it. Shown to the Reviewer. */
  reason: string;
};

export type ReplyRequest = { text: string };

/** What the caller does when a Proposal is approved. Each returns what the model then reads. */
export type WriteEffects = {
  applyDataFix(request: DataFixRequest): Promise<string>;
  sendCustomerReply(request: ReplyRequest): Promise<string>;
};

const dataFixArgs = z.object({
  sql: z
    .string()
    .min(1)
    .describe(
      "The single UPDATE or DELETE with a WHERE clause that corrects the data, copied from the Proposal or the Incident that documents it",
    ),
  reason: z
    .string()
    .min(1)
    .describe(
      "Why this is the right fix, naming the Evidence the Reviewer should check it against",
    ),
});

const replyArgs = z.object({
  text: z
    .string()
    .min(1)
    .describe("The Reply as the Reporter will read it, in full: no placeholders, no notes"),
});

export function createWriteTools(effects: WriteEffects): StructuredTool[] {
  return [
    tool(async (args: z.infer<typeof dataFixArgs>) => effects.applyDataFix(args), {
      name: APPLY_DATA_FIX,
      description:
        "Corrects wrong ShopLite data. A human Reviewer sees the statement and the rows it would " +
        "touch first, and approves, edits, or rejects it; only then does it run, in a transaction, " +
        "with the rows kept as they were so it can be undone. Call it once you are sure which rows " +
        "are wrong, and read the result: it says what actually changed.",
      schema: dataFixArgs,
    }),
    tool(async (args: z.infer<typeof replyArgs>) => effects.sendCustomerReply(args), {
      name: SEND_CUSTOMER_REPLY,
      description:
        "Sends the Reply to the Reporter. For a customer Ticket a human Reviewer reads it first and " +
        "approves or rewords it. Call it once, with the finished Reply, before returning the Verdict, " +
        "and carry the text the result reports back into the Verdict unchanged.",
      schema: replyArgs,
    }),
  ];
}
