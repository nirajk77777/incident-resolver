import type { Config, Ticket, Verdict } from "@incident-resolver/shared";
import { createFakeResolver } from "./fake-resolver";

/**
 * What a Resolver run tells the portal as it goes. Everything but the Verdict becomes a
 * timeline entry; the Verdict closes the Ticket. `decision` is missing on purpose: a
 * Reviewer's Decision is the portal's own event, written when the approval gate resumes
 * the run, never something the Resolver reports.
 */
export type ResolverEvent =
  | { type: "subagent_start"; name: string }
  | { type: "subagent_end"; name: string; summary?: string }
  | { type: "tool_call"; name: string; args: unknown }
  | { type: "tool_result"; name: string; result: unknown }
  | { type: "message"; text: string }
  /** A Proposal the run cannot carry out on its own: it waits here for a Decision. */
  | { type: "interrupt"; action: string; proposal: unknown }
  | { type: "verdict"; verdict: Verdict };

export type ResolverRun = {
  ticket: Ticket;
  /** Counts re-runs of the same Ticket from 1; stamped on every timeline entry. */
  run: number;
  signal?: AbortSignal;
};

/**
 * The seam between the portal and whatever investigates a Ticket. The portal reads the
 * stream, writes the timeline, and moves the lifecycle; it knows nothing else about the
 * run. A stream that ends without a Verdict left the Ticket unresolved, and the portal
 * treats that as a failed run.
 */
export type TicketResolver = {
  name: string;
  resolve(run: ResolverRun): AsyncIterable<ResolverEvent>;
};

/**
 * Which Resolver the portal runs Tickets through, from `RESOLVER` in the environment. The
 * real one plugs into this same seam when the agent package joins the portal.
 */
export function resolverFor(config: Config): TicketResolver {
  if (config.portal.resolver === "fake") {
    return createFakeResolver({ stepDelayMs: config.portal.fakeResolverStepDelayMs });
  }
  throw new Error(
    "The real Resolver is not wired into the portal yet: set RESOLVER=fake to run the scripted one",
  );
}
