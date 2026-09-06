import type { TicketStatus } from "@incident-resolver/shared";
import type { ResolverEvent } from "./resolver";

/**
 * The subagent whose start means Triage, matching `TRIAGE` in `@incident-resolver/agents`.
 * The portal matches on the name rather than importing the agent, so the seam stays the
 * only thing it knows about a run.
 */
export const TRIAGE_SUBAGENT = "triage";

/**
 * Where one Resolver event leaves the Ticket. The lifecycle lives here in the portal, read
 * off the stream, never inside the agent (PLAN.md section 4). Anything that happens after
 * an interrupt is the run carrying out an approved Proposal, so it counts as acting
 * whatever subagent does it.
 */
export function nextStatus(current: TicketStatus, event: ResolverEvent): TicketStatus {
  if (event.type === "verdict") return "closed";
  if (event.type === "interrupt") return "awaiting_approval";
  if (current === "awaiting_approval" || current === "acting") return "acting";
  if (event.type === "subagent_start") {
    return event.name === TRIAGE_SUBAGENT ? "triaging" : "investigating";
  }
  return current;
}
