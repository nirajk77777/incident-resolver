import type { TimelineEntry } from "./timeline";

export type TimelineListener = (entry: TimelineEntry) => void;

/**
 * Fans timeline entries out to the SSE connections watching a Ticket, in the order they
 * were written. Everything runs in one portal process, so this stays in memory: the
 * database is the record, this is only the live wire.
 */
export type TicketEventBus = {
  publish(ticketId: string, entry: TimelineEntry): void;
  /** Returns the unsubscribe. */
  subscribe(ticketId: string, listener: TimelineListener): () => void;
};

export function createTicketEventBus(): TicketEventBus {
  const listeners = new Map<string, Set<TimelineListener>>();

  return {
    publish(ticketId, entry) {
      for (const listener of listeners.get(ticketId) ?? []) listener(entry);
    },

    subscribe(ticketId, listener) {
      const forTicket = listeners.get(ticketId) ?? new Set<TimelineListener>();
      forTicket.add(listener);
      listeners.set(ticketId, forTicket);
      return () => {
        forTicket.delete(listener);
        if (forTicket.size === 0) listeners.delete(ticketId);
      };
    },
  };
}
