import {
  type ApprovalAction,
  allowedDecisions,
  approvalActions,
  type Ticket,
} from "@incident-resolver/shared";
import type { InterruptOnConfig } from "langchain";

/**
 * Where a run stops for a human. Deep Agents takes `interruptOn` as a map from tool name to the
 * Decisions a Reviewer may take, and raises a LangGraph interrupt before the tool runs; the
 * portal reads the Proposal off that interrupt and resumes the thread with the Decision.
 *
 * All three gated actions are configured. `create_pull_request` is the Resolver's own, like the
 * other two: the Fix Shipper pushes the branch, which nobody reads until it is proposed, and the
 * pull request against ShopLite's default branch is the write a Reviewer holds (ADR-0003).
 */
export const gatedTools: Record<ApprovalAction, InterruptOnConfig> = Object.fromEntries(
  approvalActions.map((action) => [action, { allowedDecisions: [...allowedDecisions[action]] }]),
) as Record<ApprovalAction, InterruptOnConfig>;

/**
 * The gate for one Ticket. A Reply to a customer is always reviewed (PLAN.md section 11); a
 * tester's or Sentinel's Reply is an internal note that is never sent anywhere, so there is
 * nothing for a Reviewer to hold. Writes to data and to GitHub are gated whatever the Source.
 */
export function interruptsFor(ticket: Ticket): Record<string, InterruptOnConfig> {
  const gated = approvalActions.filter(
    (action) => action !== "send_customer_reply" || ticket.source === "customer",
  );
  return Object.fromEntries(gated.map((action) => [action, gatedTools[action]]));
}
