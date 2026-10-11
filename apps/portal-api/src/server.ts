import { createCohereProviders, createKnowledgeStore } from "@incident-resolver/mcp-incidents";
import type { Config, Db } from "@incident-resolver/shared";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { type ApprovalStore, createApprovalStore } from "./approvals/approvals";
import { createDataFixRunner } from "./approvals/data-fix";
import { createWriteEffects } from "./approvals/write-effects";
import { createPortalStore, type PortalStore } from "./db/store";
import { createDemo, type Demo } from "./demo/demo";
import type { TicketResolver } from "./resolver/resolver";
import { approvalRoutes } from "./routes/approvals";
import { demoRoutes } from "./routes/demo";
import { eventRoutes } from "./routes/events";
import { reporterRoutes } from "./routes/reporters";
import { systemRoutes } from "./routes/system";
import { ticketRoutes } from "./routes/tickets";
import { noScores, type ScoreWriter } from "./telemetry/scores";
import { createIncidentWriter, type IncidentWriter, noIncidents } from "./tickets/incidents";
import { createTicketRunner, type TicketRunner } from "./tickets/runner";
import { createTicketEventBus, type TicketEventBus } from "./timeline/bus";
import { createTimelineWriter } from "./timeline/timeline";
import { servePortalWeb } from "./web/web";

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

/** What the route plugins share: built once per portal, after the options are resolved. */
export type PortalServices = {
  config: Config;
  resolver: TicketResolver;
  demo: Demo;
  store: PortalStore;
  bus: TicketEventBus;
  approvals: ApprovalStore;
  runner: TicketRunner;
  /** Every open timeline stream, so shutting the server down does not wait on them. */
  openStreams: Set<() => void>;
};

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
 * The portal's HTTP surface: Tickets in from customers, testers and Sentinel, their live
 * timelines out over SSE, and the Reporter's own Tickets and Replies for the storefront. Each
 * area's routes are a plugin under `routes/`.
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

/**
 * Builds the services the routes share and registers every route plugin, as one plugin so
 * `createPortalApi` can mount them all under a prefix.
 */
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
  const openStreams = new Set<() => void>();
  app.addHook("onClose", async () => {
    for (const close of [...openStreams]) close();
    await runner.stop();
    await resolver.close?.();
    await dataFix.close();
    await scores.flush();
  });

  const services: PortalServices = {
    config,
    resolver,
    demo,
    store,
    bus,
    approvals,
    runner,
    openStreams,
  };
  app.register(systemRoutes, services);
  app.register(demoRoutes, services);
  app.register(ticketRoutes, services);
  app.register(approvalRoutes, services);
  app.register(reporterRoutes, services);
  app.register(eventRoutes, services);
}
