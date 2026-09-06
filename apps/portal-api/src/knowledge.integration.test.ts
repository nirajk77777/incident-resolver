import {
  createCohereProviders,
  createKnowledgeStore,
  type IncidentRecord,
  incidentDocument,
  type KnowledgeStore,
  searchRanked,
} from "@incident-resolver/mcp-incidents";
import {
  createDb,
  type Db,
  ESCALATION_REPLY,
  loadConfig,
  tickets,
} from "@incident-resolver/shared";
import { inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FAKE_VERDICT } from "./fake-resolver";
import type { ResolverEvent, TicketResolver } from "./resolver";
import { createPortalApi } from "./server";

// Needs `docker compose up`, `pnpm db:migrate`, and a COHERE_API_KEY: this is the one test
// that runs a Ticket's whole knowledge loop through the real embed and rerank pipeline.
// Run with `pnpm test:integration`. It makes three Cohere calls, which a trial key's ten a
// minute has to be shared with `mcp-incidents`, so it asks the pipeline exactly one question.

const config = loadConfig();
const cohereApiKey = process.env.COHERE_API_KEY;

let db: Db;
let app: FastifyInstance;
let baseUrl: string;
let knowledge: KnowledgeStore;
/** Everything this test wrote, removed at the end so the knowledge base is left as it was. */
const opened: string[] = [];

/** A symptom nothing seeded is about, so a match can only be the Incident written here. */
const symptom = "the loyalty points balance froze at 4,096 after the winter promotion ended";

const written = {
  rootCause:
    "The loyalty ledger's nightly rollup stopped at the promotion's end date, so every balance " +
    "kept the total it had on that night.",
  resolution:
    "Re-ran the loyalty rollup for the affected dates, which recomputed every frozen balance.",
  reply: "Your points balance is up to date again. Sorry for the wait.",
  author: "Priya",
};

/** A Resolver that gives up, so the Ticket reaches the manual resolution form. */
const givesUp: TicketResolver = {
  name: "gives-up",
  async *resolve(): AsyncIterable<ResolverEvent> {
    yield {
      type: "verdict",
      verdict: {
        ...FAKE_VERDICT,
        outcome: "escalated",
        category: "unknown",
        confidence: 0.2,
        reply: ESCALATION_REPLY,
      },
    };
  },
  resume() {
    throw new Error("This Resolver proposes nothing, so it is never resumed");
  },
};

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const created = (await response.json()) as T & { id?: string };
  if (created.id) opened.push(created.id);
  return created;
}

/** Waits for the Ticket to close, which is when the escalation has been written to the row. */
async function untilClosed(id: string): Promise<void> {
  const response = await fetch(`${baseUrl}/tickets/${id}/events`);
  const reader = (response.body as unknown as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
  let buffer = "";
  while (!buffer.includes('"status":"closed"')) {
    const chunk = await reader.next();
    if (chunk.done) return;
    buffer += new TextDecoder().decode(chunk.value);
  }
  await reader.return?.();
}

/** What the next similar Ticket's Historian would find, through the real search. */
async function searchIncidents(query: string): Promise<IncidentRecord[]> {
  const { embedder, reranker } = createCohereProviders({
    apiKey: cohereApiKey ?? "",
    models: config.models,
  });
  const ranked = await searchRanked<IncidentRecord>({
    query,
    embedder,
    reranker,
    fetchCandidates: (embedding, limit) => knowledge.nearestIncidents(embedding, limit),
    documentOf: incidentDocument,
    candidates: config.knowledge.searchCandidates,
    topK: config.knowledge.searchTopK,
  });
  return ranked.map((match) => match.item);
}

beforeAll(async () => {
  db = createDb(config.infra.databaseUrl);
  knowledge = createKnowledgeStore(db);
  app = createPortalApi({ db, config, resolver: givesUp, cohereApiKey });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") throw new Error("No port");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await app.close();
  for (const id of opened) await knowledge.deleteIncidentsForTicket(id);
  if (opened.length > 0) await db.delete(tickets).where(inArray(tickets.id, opened));
  await db.$client.end();
});

describe.skipIf(!cohereApiKey)("the knowledge loop", () => {
  it("finds a Ticket a person resolved when the next similar Ticket searches", async () => {
    const ticket = await post<{ id: string }>("/tickets", {
      source: "tester",
      title: "Loyalty points balance stuck",
      body: `A tester reports that ${symptom}.`,
    });
    await untilClosed(ticket.id);
    await post(`/tickets/${ticket.id}/resolution`, written);

    const found = await searchIncidents(symptom);
    const match = found.find((incident) => incident.sourceTicketId === ticket.id);
    expect(match).toBeDefined();
    expect(match).toMatchObject({
      rootCause: written.rootCause,
      resolution: written.resolution,
      resolvedBy: "human",
      author: "Priya",
    });
  });
});
