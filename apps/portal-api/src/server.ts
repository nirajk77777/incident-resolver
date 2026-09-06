import {
  allowedDecisions,
  type Config,
  type Db,
  type Decision,
  formatIssues,
  isApprovalAction,
  newTicketSchema,
  reviewerDecisionSchema,
} from "@incident-resolver/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { type ApprovalRecord, createApprovalStore } from "./approvals";
import { createTicketEventBus } from "./bus";
import { createDataFixRunner } from "./data-fix";
import type { TicketResolver } from "./resolver";
import { createTicketRunner } from "./runner";
import { noScores, type ScoreWriter } from "./scores";
import {
  formatSseFrame,
  lastEventIdOf,
  SSE_HEADERS,
  SSE_KEEP_ALIVE,
  SSE_KEEP_ALIVE_MS,
} from "./sse";
import { createPortalStore } from "./store";
import type { TimelineEntry } from "./timeline";
import { createWriteEffects } from "./write-effects";

export type PortalApiOptions = {
  db: Db;
  config: Config;
  /** The Resolver every Ticket is run through, chosen by config in `main.ts`. */
  resolver: TicketResolver;
  /** Where a Reviewer's Decisions and each Ticket's Outcome are scored. None by default. */
  scores?: ScoreWriter;
  logger?: boolean;
};

const ticketIdSchema = z.object({ id: z.uuid() });
const reporterSchema = z.object({ email: z.email() });

/**
 * An approval as the portal serves it. The snapshot of changed rows stays behind: it exists so
 * a person with database access can undo a fix, and it is the one thing here that was never
 * masked, since a rollback needs the rows as they truly were.
 */
function asReviewable(approval: ApprovalRecord) {
  return {
    id: approval.id,
    run: approval.run,
    action: approval.action,
    allowedDecisions: isApprovalAction(approval.action)
      ? allowedDecisions[approval.action]
      : ([] as readonly Decision[]),
    proposal: approval.proposal,
    preview: approval.preview,
    decision: approval.decision,
    editedProposal: approval.editedProposal,
    reason: approval.reason,
    result: approval.result,
    createdAt: approval.createdAt,
    decidedAt: approval.decidedAt,
    executedAt: approval.executedAt,
  };
}

/**
 * The portal's HTTP surface: Tickets in from customers, testers and Sentinel, their live
 * timelines out over SSE, and the Reporter's own Tickets and Replies for the storefront.
 * Creating a Ticket starts its run, so a client can be watching the stream before the first
 * entry lands and still see everything: the stream always replays what it missed.
 */
export function createPortalApi({
  db,
  config,
  resolver,
  scores = noScores,
  logger = false,
}: PortalApiOptions): FastifyInstance {
  // The portal holds SSE connections open for as long as a Ticket is watched, so shutdown
  // closes its sockets rather than waiting on them.
  const app = Fastify({ logger, forceCloseConnections: true });
  const store = createPortalStore(db);
  const bus = createTicketEventBus();
  const dataFix = createDataFixRunner({
    databaseUrl: config.infra.shopliteWriteDatabaseUrl,
    rowCap: config.dataFixRowCap,
  });
  const approvals = createApprovalStore({ db, dataFix });
  const effects = createWriteEffects({ approvals, dataFix, log: app.log });
  const runner = createTicketRunner({
    store,
    approvals,
    bus,
    resolver,
    effectsFor: (ticket, run) => effects(ticket.id, run),
    scores,
    runTimeoutMs: config.runTimeoutMs,
    log: app.log,
  });
  // Every open timeline stream, so shutting the server down does not wait on them.
  const openStreams = new Set<() => void>();
  app.addHook("onClose", async () => {
    for (const close of [...openStreams]) close();
    await runner.stop();
    await resolver.close?.();
    await dataFix.close();
    await scores.flush();
  });

  app.get("/health", async () => ({ status: "ok", resolver: resolver.name }));

  /**
   * What portal-web needs from the portal's own configuration: the two observability tools
   * a Ticket links out to. Serving them keeps the web app free of a build-time environment.
   */
  app.get("/config", async () => ({
    resolver: resolver.name,
    grafanaUrl: config.infra.grafanaUrl,
    langfuseBaseUrl: config.infra.langfuseBaseUrl,
  }));

  app.post("/tickets", async (request, reply) => {
    const parsed = newTicketSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Bad Request", message: formatIssues(parsed.error) });
    }
    const ticket = await store.createTicket(parsed.data);
    runner.start(ticket);
    return reply.code(201).send(ticket);
  });

  app.get("/tickets", async () => ({ tickets: await store.listTickets() }));

  app.get("/tickets/:id", async (request, reply) => {
    const params = ticketIdSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: "Not Found" });
    const ticket = await store.getTicket(params.data.id);
    if (!ticket) return reply.code(404).send({ error: "Not Found" });
    return ticket;
  });

  /**
   * The Proposals this Ticket has raised, newest first, and what became of each. The card the
   * Reviewer decides on is drawn from the newest undecided one.
   */
  app.get("/tickets/:id/approvals", async (request, reply) => {
    const params = ticketIdSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: "Not Found" });
    const ticket = await store.getTicket(params.data.id);
    if (!ticket) return reply.code(404).send({ error: "Not Found" });
    return { approvals: (await approvals.forTicket(ticket.id)).map(asReviewable) };
  });

  /**
   * A Reviewer's Decision on the Proposal a Ticket is waiting on. Recording it carries the run
   * on in the background, so this answers as soon as the Decision is safely written; what the
   * run then does arrives on the timeline like everything else.
   */
  app.post("/tickets/:id/decision", async (request, reply) => {
    const params = ticketIdSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: "Not Found" });
    const ticket = await store.getTicket(params.data.id);
    if (!ticket) return reply.code(404).send({ error: "Not Found" });

    const answer = reviewerDecisionSchema.safeParse(request.body);
    if (!answer.success) {
      return reply.code(400).send({ error: "Bad Request", message: formatIssues(answer.error) });
    }
    const result = await runner.decide(ticket, answer.data);
    if (!result.ok) {
      return reply.code(result.status).send({ error: "Conflict", message: result.message });
    }
    return reply.code(202).send({ approval: asReviewable(result.approval) });
  });

  /** What the storefront's "My tickets" page reads: one Reporter's Tickets and their Replies. */
  app.get("/reporters/:email/tickets", async (request, reply) => {
    const params = reporterSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Bad Request", message: formatIssues(params.error) });
    }
    const found = await store.ticketsForReporter(params.data.email);
    return {
      tickets: found.map((ticket) => ({
        id: ticket.id,
        title: ticket.title,
        body: ticket.body,
        traceId: ticket.traceId,
        status: ticket.status,
        outcome: ticket.outcome,
        reply: ticket.reply,
        createdAt: ticket.createdAt,
        closedAt: ticket.closedAt,
      })),
    };
  });

  /**
   * The live timeline. A client that reconnects sends the id of the last entry it saw, in
   * the `Last-Event-ID` header or the `lastEventId` query, and gets everything after it
   * before the stream goes live. The connection stays open across the close of the Ticket,
   * so a re-run keeps streaming to the same watcher.
   */
  app.get("/tickets/:id/events", async (request, reply) => {
    const params = ticketIdSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: "Not Found" });
    const ticket = await store.getTicket(params.data.id);
    if (!ticket) return reply.code(404).send({ error: "Not Found" });

    const query = z.object({ lastEventId: z.string().optional() }).safeParse(request.query);
    let cursor = lastEventIdOf(
      request.headers["last-event-id"],
      query.success ? query.data.lastEventId : undefined,
    );

    reply.hijack();
    const stream = reply.raw;
    stream.writeHead(200, SSE_HEADERS);

    const send = (entry: TimelineEntry) => {
      if (entry.id <= cursor) return;
      cursor = entry.id;
      stream.write(formatSseFrame(entry));
    };

    // Subscribing before the catch-up read means an entry written during the read is held
    // rather than lost; `send` then drops the ones the read already covered.
    const live: TimelineEntry[] = [];
    let replaying = true;
    const unsubscribe = bus.subscribe(ticket.id, (entry) => {
      if (replaying) live.push(entry);
      else send(entry);
    });

    const keepAlive = setInterval(() => stream.write(SSE_KEEP_ALIVE), SSE_KEEP_ALIVE_MS);
    const release = () => {
      clearInterval(keepAlive);
      unsubscribe();
      openStreams.delete(close);
    };
    const close = () => {
      release();
      stream.end();
    };
    openStreams.add(close);
    // The client hung up: let go of the subscription, but leave the socket to Node.
    request.raw.on("close", release);

    try {
      for (const entry of await store.eventsAfter(ticket.id, cursor)) send(entry);
      replaying = false;
      for (const entry of live) send(entry);
    } catch (error) {
      app.log.error({ ticketId: ticket.id, err: error }, "Could not catch a timeline up");
      close();
    }
  });

  return app;
}
