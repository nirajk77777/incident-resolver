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
 * All three gated actions are configured, `create_pull_request` included, whose tool the Fix
 * Shipper brings with it: a write that arrives later is gated the day it arrives rather than the
 * day someone remembers to add it.
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
