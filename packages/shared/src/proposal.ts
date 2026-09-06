import { z } from "zod";

/**
 * A write the agent wants to perform and cannot without approval, see CONTEXT.md. One shape
 * per gated action; the portal stores it on the approval record and portal-web draws the card
 * for it. Only the portal carries a Proposal out, and only after a Decision.
 */

/**
 * A data fix the agent wants to run: an UPDATE or DELETE proposed by mcp-database and
 * carried untouched to the approval gate. Only the portal executes it, after a Decision.
 */
export const dataFixProposalSchema = z.object({
  kind: z.literal("data_fix"),
  statement: z.enum(["update", "delete"]),
  /** Schema-qualified, for example `shoplite.cart_totals`. */
  table: z.string(),
  sql: z.string(),
  reason: z.string(),
  /** How many rows the WHERE clause matched when proposed, or null if that could not be counted. */
  matchingRows: z.number().int().nullable(),
  /** Always false when proposed. */
  executed: z.literal(false),
});

export type DataFixProposal = z.infer<typeof dataFixProposalSchema>;

/** The Reply the agent wants to send the Reporter. Approved or reworded, never rejected. */
export const replyProposalSchema = z.object({
  kind: z.literal("reply"),
  text: z.string().min(1),
});

export type ReplyProposal = z.infer<typeof replyProposalSchema>;

/**
 * The pull request the Fix Shipper wants to open against ShopLite. Built here so the approval
 * gate is complete before the Fix Shipper exists; nothing raises it until then.
 */
export const pullRequestProposalSchema = z.object({
  kind: z.literal("pull_request"),
  /** The branch the changed files are pushed to, named from the Ticket. */
  branch: z.string().min(1),
  title: z.string().min(1),
  /** The RCA: root cause, the failing test, and the fix. */
  body: z.string().min(1),
  /** The Workspace files the branch carries, as repository-relative paths. */
  files: z.array(z.string()),
});

export type PullRequestProposal = z.infer<typeof pullRequestProposalSchema>;

export const proposalSchema = z.discriminatedUnion("kind", [
  dataFixProposalSchema,
  replyProposalSchema,
  pullRequestProposalSchema,
]);

export type Proposal = z.infer<typeof proposalSchema>;
