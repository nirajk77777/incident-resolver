import { z } from "zod";
import type { Outcome, ResolvedBy, TicketStatus } from "./db/schema";
import { resolvedByValues } from "./db/schema";

export { type ResolvedBy, resolvedByValues } from "./db/schema";

/**
 * What a Reviewer writes to finish an escalated Ticket: the three things the agent could not
 * establish. Submitting it closes the Ticket and writes the Incident, so the knowledge base
 * learns from the runs that escalated as well as from the ones that did not.
 */
export const manualResolutionSchema = z.object({
  rootCause: z.string().min(1),
  /** What actually fixed it, in the Reviewer's words: the statement they ran, the change they made. */
  resolution: z.string().min(1),
  /** The Reply the Reporter reads in place of the holding message. */
  reply: z.string().min(1),
  /** Who resolved it. Recorded on the Incident so a search can say where a record came from. */
  author: z.string().min(1).default("Reviewer"),
});
export type ManualResolution = z.infer<typeof manualResolutionSchema>;
/** The same as the endpoint takes it in, where naming the author is the Reviewer's option. */
export type ManualResolutionInput = z.input<typeof manualResolutionSchema>;

/** As much of a Ticket as the two rules below read. */
export type Settled = {
  status: TicketStatus;
  outcome: Outcome | null;
  resolvedBy: ResolvedBy | null;
};

/** Only an escalated Ticket is waiting for a person; everything else the Resolver finished. */
export function awaitsManualResolution(ticket: Settled): boolean {
  return ticket.status === "closed" && ticket.outcome === "escalated" && ticket.resolvedBy === null;
}

/** Named so the two ways a Ticket can be resolved read the same in code as in CONTEXT.md. */
export const [BY_AGENT, BY_HUMAN] = resolvedByValues;
