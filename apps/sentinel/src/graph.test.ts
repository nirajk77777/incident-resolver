import type { LokiStream, PromVector } from "@incident-resolver/mcp-observability";
import type { NewTicket } from "@incident-resolver/shared";
import { describe, expect, it } from "vitest";
import { runSentinelPass, type SentinelDeps } from "./graph";
import type { OpenedTicket, PortalClient } from "./portal";
import { createReportLedger } from "./recent";
import { createTicketWriter } from "./ticket-text";

const thresholds = { errorRatio: 0.2, windowSeconds: 60, minRequests: 5 };
const checkout = "/customers/:customerId/checkout";

const sample = (route: string, code: string, count: number) => ({
  metric: { http_route: route, http_response_status_code: code },
  value: [1_788_000_000, String(count)] as [number, string],
});

const spiking: PromVector = [sample(checkout, "201", 3), sample(checkout, "500", 97)];
const healthy: PromVector = [sample(checkout, "201", 100)];

const logStream: LokiStream[] = [
  {
    stream: {
      service_name: "shoplite-api",
      detected_level: "error",
      trace_id: "a".repeat(32),
    },
    values: [["1788000000000000000", "Reduce of empty array with no initial value"]],
  },
];

/** A Sentinel wired to fakes, with whatever the test wants to change. */
function sentinel(over: Partial<SentinelDeps> = {}) {
  const filed: NewTicket[] = [];
  const portal: PortalClient = {
    async openTicket(ticket): Promise<OpenedTicket> {
      filed.push(ticket);
      return { id: "00000000-0000-4000-8000-000000000001", title: ticket.title, created: true };
    },
  };
  const deps: SentinelDeps = {
    prometheus: {
      query: async () => spiking,
      queryRange: async () => [],
    },
    loki: { queryRange: async () => logStream },
    portal,
    writeTicket: createTicketWriter({}),
    thresholds,
    serviceName: "shoplite-api",
    ...over,
  };
  return { deps, filed };
}

describe("one pass of Sentinel", () => {
  it("opens a Ticket about the failing route, with its fingerprint and a trace id", async () => {
    const { deps, filed } = sentinel();

    const pass = await runSentinelPass(deps);

    expect(pass.anomaly?.route).toBe(checkout);
    expect(pass.opened?.created).toBe(true);
    expect(filed).toEqual([
      {
        source: "sentinel",
        title: "97% of /customers/:customerId/checkout requests are failing",
        body: expect.stringContaining("Reduce of empty array with no initial value"),
        fingerprint: `${checkout}:http_500`,
        traceId: "a".repeat(32),
      },
    ]);
    expect(filed[0]?.body).toContain(`Trace ids: ${"a".repeat(32)}`);
  });

  it("does nothing at all when every route is healthy", async () => {
    const { deps, filed } = sentinel({
      prometheus: { query: async () => healthy, queryRange: async () => [] },
    });

    const pass = await runSentinelPass(deps);

    expect(pass.anomaly).toBeNull();
    expect(pass.opened).toBeNull();
    expect(filed).toEqual([]);
  });

  it("still opens the Ticket when Loki is down, and says the logs were missing", async () => {
    const { deps, filed } = sentinel({
      loki: {
        queryRange: async () => {
          throw new Error("connect ECONNREFUSED 127.0.0.1:3100");
        },
      },
    });

    const pass = await runSentinelPass(deps);

    expect(pass.warnings).toEqual(["Logs unavailable: connect ECONNREFUSED 127.0.0.1:3100"]);
    expect(filed).toHaveLength(1);
    expect(filed[0]?.traceId).toBeUndefined();
    expect(filed[0]?.body).not.toContain("Trace ids");
  });

  it("reports that it joined a Ticket already open on the same fingerprint", async () => {
    const { deps } = sentinel({
      portal: {
        async openTicket(ticket) {
          return {
            id: "00000000-0000-4000-8000-000000000002",
            title: ticket.title,
            created: false,
          };
        },
      },
    });

    const pass = await runSentinelPass(deps);

    expect(pass.opened).toMatchObject({ created: false });
  });

  it("does not report the same window of failures twice", async () => {
    // Ten seconds later the spike is still inside the sixty-second window, so a second pass
    // sees the same requests. Filing them again would be a second Ticket about one problem,
    // and the portal cannot stop it once the first Ticket has closed.
    const { deps, filed } = sentinel({ reported: createReportLedger(60_000) });

    await runSentinelPass(deps);
    const second = await runSentinelPass(deps);

    expect(filed).toHaveLength(1);
    expect(second.anomaly).toBeNull();
  });

  it("still reports another route while one is held", async () => {
    const { deps, filed } = sentinel({
      reported: createReportLedger(60_000),
      prometheus: {
        query: async () => [
          ...spiking,
          sample("/products", "200", 10),
          sample("/products", "500", 10),
        ],
        queryRange: async () => [],
      },
    });

    await runSentinelPass(deps);
    await runSentinelPass(deps);

    expect(filed.map((ticket) => ticket.fingerprint)).toEqual([
      `${checkout}:http_500`,
      "/products:http_500",
    ]);
  });

  it("takes the worst route when several are over the threshold", async () => {
    const { deps, filed } = sentinel({
      prometheus: {
        query: async () => [
          sample("/products", "200", 10),
          sample("/products", "500", 10),
          ...spiking,
        ],
        queryRange: async () => [],
      },
    });

    await runSentinelPass(deps);

    expect(filed).toHaveLength(1);
    expect(filed[0]?.fingerprint).toBe(`${checkout}:http_500`);
  });
});
