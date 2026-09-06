import { z } from "zod";
import type { Decision } from "./db/schema";
import { type Proposal, proposalSchema } from "./proposal";

export { type Decision, decisions } from "./db/schema";

/**
 * The three writes the agent cannot make on its own (PLAN.md section 5). Each is a tool the
 * Resolver's graph is interrupted on: the run stops with the Proposal on the Ticket, a
 * Reviewer decides, and only then does the tool run.
 */
export const approvalActions = [
  "apply_data_fix",
  "create_pull_request",
  "send_customer_reply",
] as const;
export type ApprovalAction = (typeof approvalActions)[number];

/**
 * What a Reviewer may do with each Proposal. A data fix can be corrected before it runs, a
 * Reply can be reworded, and a pull request is taken or left as the agent wrote it: editing
 * a diff in a textarea is not review, it is authoring.
 */
export const allowedDecisions = {
  apply_data_fix: ["approve", "edit", "reject"],
  create_pull_request: ["approve", "reject"],
  send_customer_reply: ["approve", "edit"],
} as const satisfies Record<ApprovalAction, readonly Decision[]>;

const actions = new Set<string>(approvalActions);

export function isApprovalAction(name: string): name is ApprovalAction {
  return actions.has(name);
}

/** Whether this Decision is one of the ones the action allows. */
export function permits(action: ApprovalAction, decision: Decision): boolean {
  return (allowedDecisions[action] as readonly Decision[]).includes(decision);
}

/** The Reviewer's answer to one Proposal, as the decision endpoint takes it in. */
export const reviewerDecisionSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("approve") }),
  z.object({
    decision: z.literal("edit"),
    /** The Proposal as the Reviewer corrected it; it replaces the agent's arguments. */
    proposal: proposalSchema,
  }),
  z.object({
    decision: z.literal("reject"),
    /** Why. The agent is told this, so it can decide what to do instead. */
    reason: z.string().min(1),
  }),
]);
export type ReviewerDecision = z.infer<typeof reviewerDecisionSchema>;

/**
 * The tool arguments a Proposal becomes. An edited Proposal is handed back to the agent as
 * the arguments of the call it was interrupted on, so this is the inverse of the reading the
 * portal does when it raises the interrupt.
 */
export function argumentsOf(proposal: Proposal): Record<string, unknown> {
  switch (proposal.kind) {
    case "data_fix":
      return { sql: proposal.sql, reason: proposal.reason };
    case "reply":
      return { text: proposal.text };
    case "pull_request":
      return {
        branch: proposal.branch,
        title: proposal.title,
        body: proposal.body,
        files: proposal.files,
      };
  }
}
