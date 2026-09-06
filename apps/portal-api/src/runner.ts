import type { WriteEffects } from "@incident-resolver/agents";
import {
  type ApprovalAction,
  ESCALATION_REPLY,
  isApprovalAction,
  messageOf,
  permits,
  type ReviewerDecision,
  type TicketEventType,
  type TicketStatus,
  type Verdict,
} from "@incident-resolver/shared";
import type { FastifyBaseLogger } from "fastify";
import type { ApprovalRecord, ApprovalStore, RecordedDecision } from "./approvals";
import { settledProposal } from "./approvals";
import type { TicketEventBus } from "./bus";
import type { ResolverDecision, ResolverEvent, TicketResolver } from "./resolver";
import type { ScoreWriter } from "./scores";
import { nextStatus } from "./status";
import type { PortalStore, TicketRecord } from "./store";
import { timelineEntryFor } from "./timeline";

export type TicketRunnerOptions = {
  store: PortalStore;
  approvals: ApprovalStore;
  bus: TicketEventBus;
  resolver: TicketResolver;
  /** What the portal does when one of a run's writes is approved, built per Ticket. */
  effectsFor: (ticket: TicketRecord, run: number) => WriteEffects;
  /** Every Decision and every Outcome is written back to the run's Langfuse trace. */
  scores: ScoreWriter;
  /** A run that takes longer than this is abandoned and the Ticket escalated. */
  runTimeoutMs: number;
  log: FastifyBaseLogger;
};

/** Why a Decision could not be taken, in the terms the HTTP layer answers in. */
export type DecisionRefused = { ok: false; status: number; message: string };
export type DecisionTaken = { ok: true; approval: ApprovalRecord };
export type DecisionResult = DecisionTaken | DecisionRefused;

/**
 * Runs Tickets through the Resolver, one independent run each. Nothing is shared between
 * runs but the store and the bus, so any number of Tickets can be in flight at once.
 */
export type TicketRunner = {
  /** Starts a run in the background. The Ticket's own timeline reports what it does. */
  start(ticket: TicketRecord): void;
  /**
   * Records the Reviewer's answer to the Proposal this Ticket is waiting on, and starts the
   * rest of the run in the background. Returns as soon as the Decision is recorded: what the
   * run then does arrives on the timeline like everything else.
   */
  decide(ticket: TicketRecord, answer: ReviewerDecision): Promise<DecisionResult>;
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
  approvals,
  bus,
  resolver,
  effectsFor,
  scores,
  runTimeoutMs,
  log,
}: TicketRunnerOptions): TicketRunner {
  const inFlight = new Set<Promise<void>>();
  const shutdown = new AbortController();

  async function record(
    ticketId: string,
    run: number,
    entry: { type: TicketEventType; payload: Record<string, unknown> },
  ): Promise<void> {
    bus.publish(ticketId, await store.appendEvent({ ticketId, run, ...entry }));
  }

  async function moveTo(ticket: TicketRecord, run: number, status: TicketStatus): Promise<void> {
    await store.setStatus(ticket.id, status);
    await record(ticket.id, run, { type: "status", payload: { status } });
  }

  /**
   * The Verdict carries the Outcome and the Reply that make a Ticket closed: one write. Two
   * things the portal knows and the agent does not are settled here first. A Reply a Reviewer
   * approved is what the Reporter reads, even if the Resolver then worded its Verdict
   * differently, since the approved text is the one that was sent. And a Ticket may only close
   * `data_fixed` if a fix this run proposed was approved and actually changed rows: the
   * approval records are what happened, and a Verdict that disagrees with them is not the
   * story a Reporter is told.
   */
  async function close(ticket: TicketRecord, run: number, verdict: Verdict): Promise<void> {
    const [approved, fixed] = await Promise.all([
      approvals.approvedReply(ticket.id, run),
      verdict.outcome === "data_fixed"
        ? approvals.dataFixApplied(ticket.id, run)
        : Promise.resolve(true),
    ]);
    let closing = approved ? { ...verdict, reply: approved } : verdict;
    if (!fixed) {
      log.warn({ ticketId: ticket.id, run }, "A Verdict claimed a data fix that never ran");
      closing = {
        ...closing,
        outcome: "escalated",
        rootCause: `${closing.rootCause} No approved data fix changed any rows, so this was escalated rather than closed as fixed.`,
        reply: ESCALATION_REPLY,
      };
      await record(ticket.id, run, {
        type: "message",
        payload: {
          text: "The Verdict said the data was fixed, but no approved fix changed any rows.",
          reason: "unverified_fix",
        },
      });
    }
    const closed = await store.closeTicket(ticket.id, closing);
    await record(ticket.id, run, { type: "status", payload: { status: "closed" } });
    scores.outcome(closed.langfuseTraceId, closing.outcome);
  }

  /**
   * Opens the Proposal a run has stopped on: the approval record the Reviewer decides
   * against, and the timeline entry that shows it. The card is drawn from this entry, so it
   * carries the Proposal as the portal completed it and the rows it would touch.
   */
  async function pause(
    ticket: TicketRecord,
    run: number,
    event: Extract<ResolverEvent, { type: "interrupt" }>,
  ): Promise<void> {
    const approval = await approvals.open({
      ticketId: ticket.id,
      run,
      action: event.action,
      args: event.args,
      reporterEmail: ticket.reporterEmail ?? undefined,
    });
    await record(ticket.id, run, {
      type: "interrupt",
      payload: {
        approvalId: approval.id,
        action: approval.action,
        proposal: approval.proposal,
        preview: approval.preview,
      },
    });
    await moveTo(ticket, run, "awaiting_approval");
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
    if (event.type === "interrupt") {
      await pause(ticket, run, event);
      return "awaiting_approval";
    }
    await record(ticket.id, run, timelineEntryFor(event));
    const next = nextStatus(status, event);
    if (next === status) return status;
    if (event.type === "verdict") {
      await close(ticket, run, event.verdict);
    } else {
      await moveTo(ticket, run, next);
    }
    return next;
  }

  /**
   * Reads one stream of a run to its end and reports where it left the Ticket. A stream that
   * ends at `awaiting_approval` has not failed: it is waiting, and the Decision endpoint is
   * what starts the next one.
   */
  async function consume(
    ticket: TicketRecord,
    runNumber: number,
    from: TicketStatus,
    stream: AsyncIterable<ResolverEvent>,
  ): Promise<void> {
    let status = from;
    try {
      for await (const event of stream) {
        status = await apply(ticket, runNumber, status, event);
      }
      if (status !== "closed" && status !== "awaiting_approval") {
        throw new Error("the Resolver stream ended without a Verdict");
      }
    } catch (error) {
      const reason = messageOf(error);
      log.error({ ticketId: ticket.id, run: runNumber, err: error }, "Resolver run failed");
      await escalate(ticket, runNumber, status, reason);
    }
  }

  function signalFor(): AbortSignal {
    return AbortSignal.any([shutdown.signal, AbortSignal.timeout(runTimeoutMs)]);
  }

  async function run(ticket: TicketRecord): Promise<void> {
    const runNumber = await store.nextRun(ticket.id);
    const stream = resolver.resolve({
      ticket: ticketFor(ticket),
      run: runNumber,
      effects: effectsFor(ticket, runNumber),
      signal: signalFor(),
    });
    await consume(ticket, runNumber, ticket.status, stream);
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
      await close(ticket, runNumber, failedVerdict(reason));
    } catch (error) {
      log.error({ ticketId: ticket.id, err: error }, "Could not escalate a failed run");
    }
  }

  /** Waits for every run, including any a run started while we were waiting. */
  async function drain(): Promise<void> {
    while (inFlight.size > 0) await Promise.all([...inFlight]);
  }

  function track(work: Promise<void>): void {
    const promise = work.finally(() => inFlight.delete(promise));
    inFlight.add(promise);
  }

  return {
    start(ticket) {
      track(run(ticket));
    },

    async decide(ticket, answer) {
      const pending = await approvals.pending(ticket.id);
      if (!pending || ticket.status !== "awaiting_approval") {
        return { ok: false, status: 409, message: "This Ticket is not waiting on a Proposal" };
      }
      if (!isApprovalAction(pending.action)) {
        return { ok: false, status: 409, message: `${pending.action} is not a gated action` };
      }
      const action = pending.action;
      if (!permits(action, answer.decision)) {
        return {
          ok: false,
          status: 400,
          message: `A ${action.replace(/_/g, " ")} Proposal cannot be ${answer.decision}ed`,
        };
      }
      const decided = await approvals.decide(pending.id, answer satisfies RecordedDecision);
      // Lost the race with another Reviewer: the run is already carrying their answer out.
      if (!decided) {
        return { ok: false, status: 409, message: "This Proposal has already been decided" };
      }

      await record(ticket.id, decided.run, {
        type: "decision",
        payload: {
          approvalId: decided.id,
          action: decided.action,
          decision: decided.decision,
          proposal: decided.editedProposal ?? decided.proposal,
          reason: decided.reason,
        },
      });
      scores.decision(ticket.langfuseTraceId, {
        action,
        decision: answer.decision,
        reason: decided.reason,
      });
      await moveTo(ticket, decided.run, "acting");

      const stream = resolver.resume(
        {
          ticket: ticketFor(ticket),
          run: decided.run,
          effects: effectsFor(ticket, decided.run),
          signal: signalFor(),
        },
        resolverDecisionFor(action, decided, answer),
      );
      track(consume({ ...ticket, status: "acting" }, decided.run, "acting", stream));
      return { ok: true, approval: decided };
    },

    async stop() {
      shutdown.abort(new Error("The portal is shutting down"));
      await drain();
    },
  };
}

/** The Ticket as the Resolver reads it: the row, without the portal's own bookkeeping. */
function ticketFor(ticket: TicketRecord) {
  return {
    id: ticket.id,
    source: ticket.source,
    reporterEmail: ticket.reporterEmail ?? undefined,
    traceId: ticket.traceId ?? undefined,
    title: ticket.title,
    body: ticket.body,
  };
}

/**
 * The Decision as the paused run hears it. An edit reaches the agent as the arguments of the
 * call it was interrupted on, so the tool runs on the Reviewer's wording rather than its own.
 */
function resolverDecisionFor(
  action: ApprovalAction,
  approval: ApprovalRecord,
  answer: ReviewerDecision,
): ResolverDecision {
  if (answer.decision === "edit") {
    return { action, decision: "edit", proposal: settledProposal(approval) ?? answer.proposal };
  }
  if (answer.decision === "reject") {
    return { action, decision: "reject", reason: answer.reason };
  }
  return { action, decision: "approve" };
}
