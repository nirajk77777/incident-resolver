import {
  BY_AGENT,
  BY_HUMAN,
  type Db,
  type ManualResolution,
  type TicketEventType,
  type TicketStatus,
  ticketEvents,
  tickets,
  type Verdict,
} from "@incident-resolver/shared";
import { and, desc, eq, gt, max, sql } from "drizzle-orm";
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
  /** Points the Ticket at the Langfuse trace of the run investigating it now. */
  setLangfuseTrace(id: string, langfuseTraceId: string): Promise<void>;
  /**
   * Closes a Ticket on its Verdict: exactly one Outcome and one Reply, and a closed time. A
   * Ticket the Resolver settled is resolved by the agent; an escalated one is resolved by
   * nobody yet, which is what leaves it waiting for the manual resolution form.
   */
  closeTicket(id: string, verdict: Verdict, resolution: string): Promise<TicketRecord>;
  /**
   * Finishes an escalated Ticket on what a Reviewer wrote. It stays closed and its Outcome
   * stays `escalated` — that is how it ended — but the holding Reply is replaced by theirs,
   * and it is marked resolved by a human, which is what takes it off the waiting list.
   * `closedAt` is left alone: it is when the run closed the Ticket, which is still true.
   */
  resolveManually(id: string, resolution: ManualResolution): Promise<TicketRecord>;
  /**
   * Takes a closed Ticket back to `new` for another Run, clearing what the last one concluded:
   * the Outcome and the Reply have to go together for the Ticket to stop being closed, and a
   * root cause from a run that has been superseded is worse than none. The Timeline keeps
   * every earlier run, labelled by its number, so nothing is lost by clearing the row.
   */
  reopen(id: string): Promise<TicketRecord>;
  /**
   * The run this Ticket is on, counting from 1, or 0 for one no run has written to yet. The
   * next run is this plus one: a Ticket has one run at a time, so the highest so far is the
   * whole answer; a re-run that could overlap the previous one would have to claim its number
   * under a lock on the Ticket row instead.
   */
  latestRun(ticketId: string): Promise<number>;
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
      // Matched without regard to case: an email address is not case-sensitive, and the
      // storefront asks with whatever the Reporter is signed in as. mcp-database resolves the
      // same Reporter the same way, so one address is one person on both sides of the seam.
      return db
        .select()
        .from(tickets)
        .where(sql`lower(${tickets.reporterEmail}) = lower(${email})`)
        .orderBy(desc(tickets.createdAt))
        .limit(TICKET_LIST_LIMIT);
    },

    async setStatus(id, status) {
      await db.update(tickets).set({ status }).where(eq(tickets.id, id));
    },

    async setLangfuseTrace(id, langfuseTraceId) {
      await db.update(tickets).set({ langfuseTraceId }).where(eq(tickets.id, id));
    },

    async closeTicket(id, verdict, resolution) {
      const [row] = await db
        .update(tickets)
        .set({
          status: "closed",
          outcome: verdict.outcome,
          reply: verdict.reply,
          category: verdict.category,
          confidence: verdict.confidence,
          rootCause: verdict.rootCause,
          resolution,
          resolvedBy: verdict.outcome === "escalated" ? null : BY_AGENT,
          closedAt: new Date(),
        })
        .where(eq(tickets.id, id))
        .returning();
      if (!row) throw new Error(`No Ticket ${id} to close`);
      return row;
    },

    async resolveManually(id, resolution) {
      const [row] = await db
        .update(tickets)
        .set({
          reply: resolution.reply,
          rootCause: resolution.rootCause,
          resolution: resolution.resolution,
          resolvedBy: BY_HUMAN,
        })
        .where(eq(tickets.id, id))
        .returning();
      if (!row) throw new Error(`No Ticket ${id} to resolve`);
      return row;
    },

    async reopen(id) {
      const [row] = await db
        .update(tickets)
        .set({
          status: "new",
          outcome: null,
          reply: null,
          category: null,
          confidence: null,
          rootCause: null,
          resolution: null,
          resolvedBy: null,
          closedAt: null,
        })
        .where(eq(tickets.id, id))
        .returning();
      if (!row) throw new Error(`No Ticket ${id} to re-run`);
      return row;
    },

    async latestRun(ticketId) {
      const [row] = await db
        .select({ highest: max(ticketEvents.run) })
        .from(ticketEvents)
        .where(eq(ticketEvents.ticketId, ticketId));
      return row?.highest ?? 0;
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
