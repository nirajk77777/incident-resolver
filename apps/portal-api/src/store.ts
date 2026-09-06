import {
  type Db,
  type TicketEventType,
  type TicketStatus,
  ticketEvents,
  tickets,
  type Verdict,
} from "@incident-resolver/shared";
import { and, desc, eq, gt, max, ne, sql } from "drizzle-orm";
import type { TimelineEntry } from "./timeline";

/** A `portal.tickets` row. */
export type TicketRecord = typeof tickets.$inferSelect;

/** What the create endpoint has: a Ticket before Postgres gives it an id and a created time. */
export type NewTicketRow = Pick<TicketRecord, "source" | "title" | "body"> & {
  reporterEmail?: string | undefined;
  traceId?: string | undefined;
  /** Sentinel's key for the problem. At most one open Ticket carries any one of these. */
  fingerprint?: string | undefined;
};

/**
 * The answer to a create: the Ticket, and whether this call is what opened it. A Sentinel
 * detection that matches a fingerprint already open joins that Ticket rather than filing
 * another, so `created` is what tells the caller whether a run has to be started.
 */
export type OpenedTicket = { ticket: TicketRecord; created: boolean };

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
  /**
   * Opens a Ticket, or answers with the one already open on the same fingerprint. Without a
   * fingerprint every call opens a new Ticket: two customers describing the same fault are
   * two Tickets, and only Sentinel claims to have identified the problem itself.
   */
  createTicket(ticket: NewTicketRow): Promise<OpenedTicket>;
  getTicket(id: string): Promise<TicketRecord | null>;
  listTickets(): Promise<TicketRecord[]>;
  /** The Tickets one Reporter opened, newest first, with their Replies. */
  ticketsForReporter(email: string): Promise<TicketRecord[]>;
  setStatus(id: string, status: TicketStatus): Promise<void>;
  /** Points the Ticket at the Langfuse trace of the run investigating it now. */
  setLangfuseTrace(id: string, langfuseTraceId: string): Promise<void>;
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
      const { fingerprint } = ticket;
      const openOnFingerprint = async () => {
        if (!fingerprint) return null;
        const [row] = await db
          .select()
          .from(tickets)
          .where(and(eq(tickets.fingerprint, fingerprint), ne(tickets.status, "closed")))
          .limit(1);
        return row ?? null;
      };

      const alreadyOpen = await openOnFingerprint();
      if (alreadyOpen) return { ticket: alreadyOpen, created: false };

      try {
        const [row] = await db
          .insert(tickets)
          .values({
            source: ticket.source,
            reporterEmail: ticket.reporterEmail ?? null,
            traceId: ticket.traceId ?? null,
            fingerprint: fingerprint ?? null,
            title: ticket.title,
            body: ticket.body,
          })
          .returning();
        if (!row) throw new Error("Insert returned no Ticket");
        return { ticket: row, created: true };
      } catch (error) {
        // Two detections of one spike landing together: the partial unique index refused
        // this one, so the Ticket the other opened is the answer.
        if (!isUniqueViolation(error)) throw error;
        const won = await openOnFingerprint();
        if (!won) throw error;
        return { ticket: won, created: false };
      }
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

/** Postgres's unique-violation code, through however many layers Drizzle wrapped the error in. */
function isUniqueViolation(error: unknown): boolean {
  for (let cause = error; cause instanceof Error; cause = cause.cause) {
    if ((cause as { code?: unknown }).code === "23505") return true;
  }
  return false;
}
