import { z } from "zod";

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
