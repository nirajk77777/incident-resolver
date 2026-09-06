import type { TicketEventType } from "@incident-resolver/shared";
import type { TimelineResolverEvent } from "./resolver";

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

/** The timeline entry one Resolver event becomes: the type it is filed under, and its payload. */
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
      return { type: event.type, payload: { name: event.name, result: event.result } };
    case "message":
      return { type: event.type, payload: { text: event.text } };
    case "interrupt":
      return { type: event.type, payload: { action: event.action, proposal: event.proposal } };
    case "verdict":
      return { type: event.type, payload: { ...event.verdict } };
  }
}
