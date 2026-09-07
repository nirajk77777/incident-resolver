import type { TicketEventType } from "@incident-resolver/shared";
import type { TicketEventBus } from "./bus";
import type { TimelineResolverEvent } from "./resolver";
import type { PortalStore } from "./store";

/** A `portal.ticket_events` row as the timeline serves it. */
export type TimelineEntry = {
  /** The sequence the SSE stream sends as its event id. */
  id: number;
  /** Which run of this Ticket produced the entry, counting from 1. */
  run: number;
  type: TicketEventType;
  payload: Record<string, unknown>;
  createdAt: Date;
};

/**
 * The timeline entry one Resolver event becomes: the type it is filed under, and its payload.
 * The two entries the portal writes for itself — `status`, and the `interrupt` and `decision`
 * either side of the approval gate — are not here: they carry more than the run reported.
 */
export function timelineEntryFor(event: TimelineResolverEvent): {
  type: TicketEventType;
  payload: Record<string, unknown>;
} {
  switch (event.type) {
    case "subagent_start":
      return { type: event.type, payload: { name: event.name } };
    case "subagent_end":
      return { type: event.type, payload: { name: event.name, summary: event.summary ?? null } };
    case "tool_call":
      return { type: event.type, payload: { name: event.name, args: event.args } };
    case "tool_result":
      return {
        type: event.type,
        payload: { name: event.name, result: event.result, failed: event.failed === true },
      };
    case "message":
      return { type: event.type, payload: { text: event.text } };
    case "verdict":
      return { type: event.type, payload: { ...event.verdict } };
  }
}

/**
 * Writing one entry onto a Ticket's Timeline: stored, then put on the live wire so whoever is
 * watching sees it as it happens. The runner writes every Resolver event through this, and the
 * write effects write the one thing the portal says for itself — the internal note carrying a
 * pull request link, which a Reporter's Reply is never allowed to name.
 */
export type TimelineWriter = (
  ticketId: string,
  run: number,
  entry: { type: TicketEventType; payload: Record<string, unknown> },
) => Promise<void>;

export function createTimelineWriter(store: PortalStore, bus: TicketEventBus): TimelineWriter {
  return async (ticketId, run, entry) => {
    bus.publish(ticketId, await store.appendEvent({ ticketId, run, ...entry }));
  };
}
