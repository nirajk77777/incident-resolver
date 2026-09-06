import {
  type Db,
  type TicketEventType,
  type TicketStatus,
  ticketEvents,
  tickets,
  type Verdict,
} from "@incident-resolver/shared";
import { and, desc, eq, gt, max } from "drizzle-orm";
import type { TimelineEntry } from "./timeline";

/** A `portal.tickets` row. */
export type TicketRecord = typeof tickets.$inferSelect;

/** What the create endpoint has: a Ticket before Postgres gives it an id and a created time. */
export type NewTicketRow = Pick<TicketRecord, "source" | "title" | "body"> & {
  reporterEmail?: string | undefined;
  traceId?: string | undefined;
};

export type NewTimelineEntry = {
  ticketId: string;
  run: number;
  type: TicketEventType;
  payload: Record<string, unknown>;
};

/** Newest first, and capped: the portal list is a support desk queue, not an archive. */
export const TICKET_LIST_LIMIT = 200;

/**
 * The `portal` schema: Tickets and their timelines. Everything the API and the runner know
 * about storage is here, so the lifecycle rules can be read in one place.
 */
export type PortalStore = {
  createTicket(ticket: NewTicketRow): Promise<TicketRecord>;
  getTicket(id: string): Promise<TicketRecord | null>;
  listTickets(): Promise<TicketRecord[]>;
  /** The Tickets one Reporter opened, newest first, with their Replies. */
  ticketsForReporter(email: string): Promise<TicketRecord[]>;
  setStatus(id: string, status: TicketStatus): Promise<void>;
  /** Closes a Ticket on its Verdict: exactly one Outcome and one Reply, and a closed time. */
  closeTicket(id: string, verdict: Verdict): Promise<TicketRecord>;
  /**
   * The number of the run about to start, counting this Ticket's runs from 1. One Ticket
   * has one run at a time, so this reads the highest so far; a re-run endpoint that could
   * overlap runs would have to claim the number under a lock on the Ticket row.
   */
  nextRun(ticketId: string): Promise<number>;
  appendEvent(entry: NewTimelineEntry): Promise<TimelineEntry>;
  /** Timeline entries after `afterId`, in order. `0` asks for the whole timeline. */
  eventsAfter(ticketId: string, afterId: number): Promise<TimelineEntry[]>;
};

const entryColumns = {
  id: ticketEvents.id,
  run: ticketEvents.run,
  type: ticketEvents.type,
  payload: ticketEvents.payload,
  createdAt: ticketEvents.createdAt,
};

export function createPortalStore(db: Db): PortalStore {
  return {
    async createTicket(ticket) {
      const [row] = await db
        .insert(tickets)
        .values({
          source: ticket.source,
          reporterEmail: ticket.reporterEmail ?? null,
          traceId: ticket.traceId ?? null,
          title: ticket.title,
          body: ticket.body,
        })
        .returning();
      if (!row) throw new Error("Insert returned no Ticket");
      return row;
    },

    async getTicket(id) {
      const [row] = await db.select().from(tickets).where(eq(tickets.id, id));
      return row ?? null;
    },

    listTickets() {
      return db.select().from(tickets).orderBy(desc(tickets.createdAt)).limit(TICKET_LIST_LIMIT);
    },

    ticketsForReporter(email) {
      return db
        .select()
        .from(tickets)
        .where(eq(tickets.reporterEmail, email))
        .orderBy(desc(tickets.createdAt))
        .limit(TICKET_LIST_LIMIT);
    },

    async setStatus(id, status) {
      await db.update(tickets).set({ status }).where(eq(tickets.id, id));
    },

    async closeTicket(id, verdict) {
      const [row] = await db
        .update(tickets)
        .set({
          status: "closed",
          outcome: verdict.outcome,
          reply: verdict.reply,
          category: verdict.category,
          confidence: verdict.confidence,
          rootCause: verdict.rootCause,
          closedAt: new Date(),
        })
        .where(eq(tickets.id, id))
        .returning();
      if (!row) throw new Error(`No Ticket ${id} to close`);
      return row;
    },

    async nextRun(ticketId) {
      const [row] = await db
        .select({ highest: max(ticketEvents.run) })
        .from(ticketEvents)
        .where(eq(ticketEvents.ticketId, ticketId));
      return (row?.highest ?? 0) + 1;
    },

    async appendEvent(entry) {
      const [row] = await db.insert(ticketEvents).values(entry).returning(entryColumns);
      if (!row) throw new Error("Insert returned no timeline entry");
      return row;
    },

    eventsAfter(ticketId, afterId) {
      return db
        .select(entryColumns)
        .from(ticketEvents)
        .where(and(eq(ticketEvents.ticketId, ticketId), gt(ticketEvents.id, afterId)))
        .orderBy(ticketEvents.id);
    },
  };
}
