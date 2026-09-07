import { createCohereProviders, createKnowledgeStore } from "@incident-resolver/mcp-incidents";
import {
  allowedDecisions,
  type Config,
  type Db,
  type Decision,
  formatIssues,
  isApprovalAction,
  manualResolutionSchema,
  messageOf,
  newTicketSchema,
  reviewerDecisionSchema,
} from "@incident-resolver/shared";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { z } from "zod";
import { type ApprovalRecord, createApprovalStore } from "./approvals";
import { createTicketEventBus } from "./bus";
import { createDataFixRunner } from "./data-fix";
import { createDemo, type Demo } from "./demo";
import { createIncidentWriter, type IncidentWriter, noIncidents } from "./incidents";
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
import { createTimelineWriter, type TimelineEntry } from "./timeline";
import { servePortalWeb } from "./web";
import { createWriteEffects } from "./write-effects";

export type PortalApiOptions = {
  db: Db;
  config: Config;
  /** The Resolver every Ticket is run through, chosen by config in `main.ts`. */
  resolver: TicketResolver;
  /** The rehearsal props behind the hidden Demo panel. Built from config by default. */
  demo?: Demo;
  /** Where a Reviewer's Decisions and each Ticket's Outcome are scored. None by default. */
  scores?: ScoreWriter;
  /**
   * Where a closed Ticket's Incident is written, so the next similar Ticket finds it. Left out,
   * one is built over the `knowledge` schema and Cohere.
   */
  incidents?: IncidentWriter;
  /**
   * Embeds the Incidents a close writes. A secret, so it comes from the environment rather than
   * from config; without it nothing is written to the knowledge base and everything else runs.
   */
  cohereApiKey?: string | undefined;
  logger?: boolean;
  /**
   * Where the routes are mounted. Empty — the default, and what tests use — puts them at the
   * root, behind the Vite dev server's `/api` proxy. The deployed container passes `/api`,
   * because there the portal's pages are served from this same origin at the root.
   */
  apiPrefix?: string;
  /** Serve the built portal-web from here too. Omitted and this process is the API alone. */
  webDistDir?: string;
};

const ticketIdSchema = z.object({ id: z.uuid() });
const reporterSchema = z.object({ email: z.email() });

type KnowledgeWriterOptions = {
  db: Db;
  config: Config;
  cohereApiKey: string | undefined;
  log: FastifyBaseLogger;
};

/**
 * The Incident writer a portal builds for itself: the `knowledge` schema, embedded by the same
 * Cohere model `mcp-incidents` indexes with, so what a close writes is found by the search the
 * next Ticket's Historian runs. Without the key there is nothing to embed with, and a Ticket
 * still closes; the portal says so once at startup rather than on every Ticket.
 */
function knowledgeWriter({
  db,
  config,
  cohereApiKey,
  log,
}: KnowledgeWriterOptions): IncidentWriter {
  if (!cohereApiKey) {
    log.warn("COHERE_API_KEY is not set: closed Tickets will not be written to the knowledge base");
    return noIncidents;
  }
  const { embedder } = createCohereProviders({ apiKey: cohereApiKey, models: config.models });
  return createIncidentWriter({ store: createKnowledgeStore(db), embedder, log });
}

/**
 * An approval as the portal serves it. The snapshot of changed rows stays behind: it exists so
 * a person with database access can undo a fix, and it is the one thing here that was never
 * masked, since a rollback needs the rows as they truly were.
 */
function approvalBody(approval: ApprovalRecord) {
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
export function createPortalApi(options: PortalApiOptions): FastifyInstance {
  const { logger = false, apiPrefix = "", webDistDir } = options;
  // The portal holds SSE connections open for as long as a Ticket is watched, so shutdown
  // closes its sockets rather than waiting on them.
  const app = Fastify({ logger, forceCloseConnections: true });
  app.register(portalRoutes, { ...options, prefix: apiPrefix });
  if (webDistDir) servePortalWeb(app, { webDistDir, apiPrefix });
  return app;
}

/** The routes themselves, as a plugin so `createPortalApi` can mount them under a prefix. */
async function portalRoutes(
  app: FastifyInstance,
  {
    db,
    config,
    resolver,
    demo = createDemo({ db, config }),
    scores = noScores,
    incidents,
    cohereApiKey = process.env.COHERE_API_KEY,
  }: PortalApiOptions,
): Promise<void> {
  const store = createPortalStore(db);
  const bus = createTicketEventBus();
  const dataFix = createDataFixRunner({
    databaseUrl: config.infra.shopliteWriteDatabaseUrl,
    rowCap: config.dataFixRowCap,
  });
  const approvals = createApprovalStore({ db, dataFix });
  // One writer for everything that lands on a Timeline: the runner's entries for what the run
  // did, and the write effects' internal note for what the portal did with an approved write.
  const record = createTimelineWriter(store, bus);
  const effects = createWriteEffects({ approvals, dataFix, record, log: app.log });
  const runner = createTicketRunner({
    store,
    approvals,
    resolver,
    record,
    effectsFor: (ticket, run) => effects(ticket.id, run),
    scores,
    incidents: incidents ?? knowledgeWriter({ db, config, cohereApiKey, log: app.log }),
    confidenceThreshold: config.confidenceThreshold,
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

  /**
   * The two buttons on the portal's hidden Demo panel, and the only routes here that exist
   * for a rehearsal rather than for the product. Traffic is relayed to ShopLite, status and
   * all, so a burst already running comes back worded as ShopLite worded it.
   */
  app.post("/demo/simulate-traffic", async (request, reply) => {
    try {
      const answer = await demo.simulateTraffic(request.body ?? {});
      return reply.code(answer.status).send(answer.body);
    } catch (error) {
      app.log.error({ err: error }, "Could not reach ShopLite to simulate traffic");
      return reply.code(502).send({ error: "Bad Gateway", message: messageOf(error) });
    }
  });

  /**
   * Puts everything back: ShopLite reseeded, Tickets and their timelines, approvals,
   * checkpoints and Workspaces cleared, Incidents kept. It refuses while a Ticket is still
   * running, since deleting a Ticket out from under its own run leaves the run writing to
   * something that is not there.
   */
  app.post("/demo/reset", async (_request, reply) => {
    const running = runner.busy();
    if (running > 0) {
      return reply.code(409).send({
        error: "Conflict",
        message: `${running} ${running === 1 ? "Ticket is" : "Tickets are"} still running. Wait for them to close, then reset.`,
      });
    }
    const report = await demo.reset();
    return reply.code(report.ok ? 200 : 500).send(report);
  });

  app.post("/tickets", async (request, reply) => {
    const parsed = newTicketSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Bad Request", message: formatIssues(parsed.error) });
    }
    // A Sentinel detection that matches a fingerprint already open joins that Ticket: the
    // same spike seen twice is one problem, and answering 200 tells Sentinel which one.
    const { ticket, created } = await store.createTicket(parsed.data);
    if (!created) return reply.code(200).send(ticket);
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
    return { approvals: (await approvals.forTicket(ticket.id)).map(approvalBody) };
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
      const error = result.status === 400 ? "Bad Request" : "Conflict";
      return reply.code(result.status).send({ error, message: result.message });
    }
    return reply.code(202).send({ approval: approvalBody(result.approval) });
  });

  /**
   * How a Reviewer finishes an escalated Ticket: the root cause, what fixed it, and the Reply
   * the Reporter reads in place of the holding message. Submitting it writes the Incident, so
   * the knowledge base learns from the Tickets the Resolver could not finish as well as from
   * the ones it could.
   */
  app.post("/tickets/:id/resolution", async (request, reply) => {
    const params = ticketIdSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: "Not Found" });
    const ticket = await store.getTicket(params.data.id);
    if (!ticket) return reply.code(404).send({ error: "Not Found" });

    const written = manualResolutionSchema.safeParse(request.body);
    if (!written.success) {
      return reply.code(400).send({ error: "Bad Request", message: formatIssues(written.error) });
    }
    const result = await runner.resolve(ticket, written.data);
    if (!result.ok) {
      return reply.code(result.status).send({ error: "Conflict", message: result.message });
    }
    return result.ticket;
  });

  /**
   * Runs a closed Ticket again. The new run gets the next run number and its own thread, so
   * nothing it does can reach the checkpoint the last one left; the Timeline keeps both,
   * labelled by run. This answers as soon as the Ticket is reopened, and what the run then
   * does arrives on the timeline like everything else.
   */
  app.post("/tickets/:id/rerun", async (request, reply) => {
    const params = ticketIdSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: "Not Found" });
    const ticket = await store.getTicket(params.data.id);
    if (!ticket) return reply.code(404).send({ error: "Not Found" });

    const result = await runner.rerun(ticket);
    if (!result.ok) {
      return reply.code(result.status).send({ error: "Conflict", message: result.message });
    }
    return reply.code(202).send(result.ticket);
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
}
