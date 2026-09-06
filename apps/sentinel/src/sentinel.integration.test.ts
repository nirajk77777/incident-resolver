import {
  createDemo,
  createPortalApi,
  type ResolverRun,
  type TicketResolver,
} from "@incident-resolver/portal-api";
import { createDb, type Db, loadConfig } from "@incident-resolver/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runSentinelPass, type SentinelDeps } from "./graph";
import { createPortalClient } from "./portal";
import { createReportLedger, reportsEverything } from "./recent";
import { createTicketWriter } from "./ticket-text";

// Needs `docker compose up` and `pnpm db:migrate`. Run with `pnpm test:integration`.
//
// Deduplication end to end: Sentinel against a real portal over real HTTP, with Prometheus
// and Loki faked so the same spike can be shown to it twice. Simulating the traffic itself is
// ShopLite's to test; what has to be proved here is that seeing it twice is one Ticket.

const config = loadConfig();
const checkout = "/customers/:customerId/checkout";
const fingerprint = `${checkout}:http_500`;

const sample = (code: string, count: number) => ({
  metric: { http_route: checkout, http_response_status_code: code },
  value: [1_788_000_000, String(count)] as [number, string],
});

/**
 * A Resolver that starts a run and then stays in it, so the Ticket it is given stays open.
 * A stream that simply ended would be a failed run, and the portal would close the Ticket —
 * which is the wrong shape for a rule about at most one *open* Ticket per fingerprint.
 */
const staysOpen: TicketResolver = {
  name: "stays-open",
  async *resolve(run: ResolverRun) {
    yield { type: "message", text: "Looking at the route" } as const;
    await new Promise<void>((resolve) => {
      run.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  },
  async *resume() {},
};

let db: Db;
let app: ReturnType<typeof createPortalApi>;
let baseUrl: string;

/** Sentinel wired to the real portal, and to a spike that is always there to be seen. */
function sentinel(over: Partial<SentinelDeps> = {}): SentinelDeps {
  return {
    prometheus: {
      query: async () => [sample("201", 3), sample("500", 97)],
      queryRange: async () => [],
    },
    loki: { queryRange: async () => [] },
    portal: createPortalClient(baseUrl),
    writeTicket: createTicketWriter({}),
    thresholds: config.sentinel,
    serviceName: config.shopliteServiceName,
    reported: reportsEverything,
    ...over,
  };
}

type TicketRow = { id: string; fingerprint: string | null; status: string };

/** Every Ticket on the queue carrying this fingerprint, however many passes have been made. */
async function ticketsOnFingerprint(): Promise<TicketRow[]> {
  const response = await fetch(`${baseUrl}/tickets`);
  const { tickets } = (await response.json()) as { tickets: TicketRow[] };
  return tickets.filter((ticket) => ticket.fingerprint === fingerprint);
}

beforeAll(async () => {
  db = createDb(config.infra.databaseUrl);
  app = createPortalApi({ db, config, resolver: staysOpen });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") throw new Error("No port");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(async () => {
  // Each case starts from an empty queue, the way a rehearsal does.
  await createDemo({
    db,
    config,
    workspaces: { for: () => ({}) as never, removeAll: async () => {} },
    resetShoplite: async () => {},
  }).reset();
});

afterAll(async () => {
  await app.close();
  await db.$client.end();
});

describe("Sentinel seeing the same spike twice", () => {
  it("opens one Ticket, and is told the second time that it already exists", async () => {
    const deps = sentinel();

    const first = await runSentinelPass(deps);
    const second = await runSentinelPass(deps);

    expect(first.opened).toMatchObject({ created: true });
    // The portal is what makes this true: the second POST matches a fingerprint already on
    // an open Ticket, so it answers with that Ticket instead of filing another.
    expect(second.opened).toMatchObject({ created: false, id: first.opened?.id });
    expect(await ticketsOnFingerprint()).toHaveLength(1);
  });

  it("does not even ask again while its own window still holds the fingerprint", async () => {
    const deps = sentinel({ reported: createReportLedger(config.sentinel.windowSeconds * 1000) });

    await runSentinelPass(deps);
    const second = await runSentinelPass(deps);

    expect(second.anomaly).toBeNull();
    expect(second.opened).toBeNull();
    expect(await ticketsOnFingerprint()).toHaveLength(1);
  });
});
