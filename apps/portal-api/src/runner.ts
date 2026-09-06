import {
  ESCALATION_REPLY,
  messageOf,
  type TicketStatus,
  type Verdict,
} from "@incident-resolver/shared";
import type { FastifyBaseLogger } from "fastify";
import type { TicketEventBus } from "./bus";
import type { ResolverEvent, TicketResolver } from "./resolver";
import { nextStatus } from "./status";
import type { PortalStore, TicketRecord } from "./store";
import { timelineEntryFor } from "./timeline";

export type TicketRunnerOptions = {
  store: PortalStore;
  bus: TicketEventBus;
  resolver: TicketResolver;
  /** A run that takes longer than this is abandoned and the Ticket escalated. */
  runTimeoutMs: number;
  log: FastifyBaseLogger;
};

/**
 * Runs Tickets through the Resolver, one independent run each. Nothing is shared between
 * runs but the store and the bus, so any number of Tickets can be in flight at once.
 */
export type TicketRunner = {
  /** Starts a run in the background. The Ticket's own timeline reports what it does. */
  start(ticket: TicketRecord): void;
  /** Abandons every in-flight run and waits for them to unwind. */
  stop(): Promise<void>;
};

/** How a run that never reached a Verdict closes: escalated, with the holding Reply. */
function failedVerdict(reason: string): Verdict {
  return {
    outcome: "escalated",
    category: "unknown",
    confidence: 0,
    rootCause: `The Resolver run did not finish: ${reason}`,
    evidence: [],
    reply: ESCALATION_REPLY,
  };
}

export function createTicketRunner({
  store,
  bus,
  resolver,
  runTimeoutMs,
  log,
}: TicketRunnerOptions): TicketRunner {
  const inFlight = new Set<Promise<void>>();
  const shutdown = new AbortController();

  async function record(
    ticketId: string,
    run: number,
    entry: ReturnType<typeof timelineEntryFor>,
  ): Promise<void> {
    bus.publish(ticketId, await store.appendEvent({ ticketId, run, ...entry }));
  }

  /** The Verdict carries the Outcome and the Reply that make a Ticket closed: one write. */
  async function close(ticketId: string, run: number, verdict: Verdict): Promise<void> {
    await store.closeTicket(ticketId, verdict);
    await record(ticketId, run, { type: "status", payload: { status: "closed" } });
  }

  /** Writes the entry for one Resolver event and moves the lifecycle if it moved. */
  async function apply(
    ticket: TicketRecord,
    run: number,
    status: TicketStatus,
    event: ResolverEvent,
  ): Promise<TicketStatus> {
    // The trace the run writes to belongs on the Ticket, not on its timeline: it is where
    // the Reviewer goes to read the run, not something the run did.
    if (event.type === "trace") {
      await store.setLangfuseTrace(ticket.id, event.langfuseTraceId);
      return status;
    }
    await record(ticket.id, run, timelineEntryFor(event));
    const next = nextStatus(status, event);
    if (next === status) return status;
    if (event.type === "verdict") {
      await close(ticket.id, run, event.verdict);
    } else {
      await store.setStatus(ticket.id, next);
      await record(ticket.id, run, { type: "status", payload: { status: next } });
    }
    return next;
  }

  async function run(ticket: TicketRecord): Promise<void> {
    const runNumber = await store.nextRun(ticket.id);
    const signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(runTimeoutMs)]);
    let status = ticket.status;

    try {
      const stream = resolver.resolve({
        ticket: {
          id: ticket.id,
          source: ticket.source,
          reporterEmail: ticket.reporterEmail ?? undefined,
          traceId: ticket.traceId ?? undefined,
          title: ticket.title,
          body: ticket.body,
        },
        run: runNumber,
        signal,
      });
      for await (const event of stream) {
        status = await apply(ticket, runNumber, status, event);
      }
      if (status !== "closed") {
        throw new Error("the Resolver stream ended without a Verdict");
      }
    } catch (error) {
      const reason = messageOf(error);
      log.error({ ticketId: ticket.id, run: runNumber, err: error }, "Resolver run failed");
      await escalate(ticket, runNumber, status, reason);
    }
  }

  /**
   * Leaves a failed run as a closed, escalated Ticket rather than one stuck mid-lifecycle,
   * which is what PLAN.md section 4 asks for on a run that fails or runs out of time. The
   * run's own view of the status is the authority: it is the only writer of this Ticket.
   */
  async function escalate(
    ticket: TicketRecord,
    runNumber: number,
    status: TicketStatus,
    reason: string,
  ): Promise<void> {
    if (status === "closed") return;
    try {
      await record(ticket.id, runNumber, {
        type: "message",
        payload: { text: `The run failed: ${reason}`, reason: "agent_error" },
      });
      await close(ticket.id, runNumber, failedVerdict(reason));
    } catch (error) {
      log.error({ ticketId: ticket.id, err: error }, "Could not escalate a failed run");
    }
  }

  /** Waits for every run, including any a run started while we were waiting. */
  async function drain(): Promise<void> {
    while (inFlight.size > 0) await Promise.all([...inFlight]);
  }

  return {
    start(ticket) {
      const promise = run(ticket).finally(() => inFlight.delete(promise));
      inFlight.add(promise);
    },

    async stop() {
      shutdown.abort(new Error("The portal is shutting down"));
      await drain();
    },
  };
}
