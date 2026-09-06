import { fileURLToPath } from "node:url";
import { loadConfig } from "@incident-resolver/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ErrorRate } from "./prometheus";
import type { LogSearchResult, MetricsResult, RecentErrorsResult } from "./server";
import type { TraceSummary } from "./tempo";

// Needs `docker compose up` and ShopLite running against it (`pnpm dev` in the shoplite
// repository, API on SHOPLITE_API_URL, default http://localhost:4000). Run with
// `pnpm test:integration`.
//
// One declined checkout is generated against ShopLite, then every assertion goes through
// the MCP client over stdio, the way portal-api will use the server. ShopLite exports
// metrics every 10s by default, so the Prometheus-backed assertions poll for a while.

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const config = loadConfig();
const shopliteApi = process.env.SHOPLITE_API_URL ?? "http://localhost:4000";

const ava = { id: "00000000-0000-4000-8000-000000000001", email: "ava.chen@example.com" };
const liam = { email: "liam.okafor@example.com" };
const mug = "00000000-0000-4000-9000-000000000001";
const declinedCard = { number: "4000000000000002", expMonth: 12, expYear: 2030 };
const checkoutRoute = "/customers/:customerId/checkout";
const declineLine = "payment declined by gateway: insufficient_funds";

/** A stream of its own in Loki, so the redaction test never touches ShopLite's lines. */
const syntheticService = "mcp-observability-test";
const syntheticTraceId = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const syntheticLine = `card ${declinedCard.number} for ${liam.email} and ${ava.email} declined`;

const metricsTimeoutMs = 90_000;

async function startServer(env: Record<string, string> = {}): Promise<Client> {
  const client = new Client({ name: "mcp-observability-test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/main.ts"],
      cwd: packageDir,
      env: { ...(process.env as Record<string, string>), ...env },
      stderr: "pipe",
    }),
  );
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const [first] = result.content as Array<{ type: string; text: string }>;
  return { text: first?.text ?? "", isError: result.isError === true };
}

async function callJson<T>(client: Client, name: string, args: Record<string, unknown> = {}) {
  const reply = await call(client, name, args);
  expect(reply.isError, reply.text).toBe(false);
  return JSON.parse(reply.text) as T;
}

/** Retries until `attempt` returns a value, since ingestion into LGTM is asynchronous. */
async function pollUntil<T>(
  what: string,
  attempt: () => Promise<T | undefined>,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const result = await attempt();
      if (result !== undefined) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const detail = lastError ? ` (last error: ${String(lastError)})` : "";
  throw new Error(`Timed out waiting for ${what}${detail}`);
}

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${shopliteApi}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Writes one line straight into Loki under a service name of its own. */
async function pushSyntheticLine(): Promise<void> {
  const response = await fetch(`${config.infra.lokiUrl}/loki/api/v1/push`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      streams: [
        {
          stream: { service_name: syntheticService },
          values: [
            [`${BigInt(Date.now()) * 1_000_000n}`, syntheticLine, { trace_id: syntheticTraceId }],
          ],
        },
      ],
    }),
  });
  if (!response.ok)
    throw new Error(`Loki push failed: ${response.status} ${await response.text()}`);
}

describe("mcp-observability over the MCP client", () => {
  let client: Client;
  let traceId: string;

  beforeAll(async () => {
    const health = await fetch(`${shopliteApi}/health`).catch(() => undefined);
    if (!health?.ok) {
      throw new Error(`ShopLite is not running on ${shopliteApi}: run \`pnpm dev\` in shoplite`);
    }

    await post(`/customers/${ava.id}/cart/items`, { productId: mug });
    const checkout = await post(`/customers/${ava.id}/checkout`, { card: declinedCard });
    expect(checkout.status).toBe(402);
    traceId = checkout.headers.get("x-trace-id") as string;
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);

    await pushSyntheticLine();
    client = await startServer();
  });

  afterAll(async () => {
    await client?.close();
  });

  it("exposes the five tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "get_error_rate",
      "get_trace",
      "list_recent_errors",
      "query_metrics",
      "search_logs",
    ]);
  });

  describe("search_logs", () => {
    it("returns the decline line for the checkout's trace id, with pino's fields", async () => {
      const result = await pollUntil("the decline line in Loki", async () => {
        const found = await callJson<LogSearchResult>(client, "search_logs", { traceId });
        return found.lines.some((line) => line.message === declineLine) ? found : undefined;
      });
      expect(result.logql).toBe(
        `{service_name="${config.shopliteServiceName}"} | trace_id="${traceId}"`,
      );
      expect(result.since).toBe("24h");
      const decline = result.lines.find((line) => line.message === declineLine);
      expect(decline).toMatchObject({
        level: "warn",
        traceId,
        fields: { declineCode: "insufficient_funds", customerId: ava.id },
      });
      expect(decline?.spanId).toMatch(/^[0-9a-f]{16}$/);
      expect(decline?.fields).not.toHaveProperty("host_name");
      expect(decline?.fields).not.toHaveProperty("process_pid");
      expect(result.lines.map((line) => line.message)).toContain("request completed");
      expect(result.truncated).toBe(false);
      expect(result.lineCap).toBe(config.logLineCap);
    });

    it("matches free text case-insensitively and filters by level and above", async () => {
      const warn = await callJson<LogSearchResult>(client, "search_logs", {
        query: "DECLINED BY GATEWAY",
        level: "warn",
        since: "10m",
      });
      expect(warn.lines.length).toBeGreaterThan(0);
      expect(warn.lines.every((line) => line.level === "warn")).toBe(true);
      expect(warn.lines.some((line) => line.traceId === traceId)).toBe(true);

      const error = await callJson<LogSearchResult>(client, "search_logs", {
        query: "declined by gateway",
        level: "error",
        since: "10m",
      });
      expect(error.lines).toEqual([]);
    });

    it("caps the line count and says when it truncated", async () => {
      const capped = await startServer({ LOG_LINE_CAP: "2" });
      try {
        const result = await callJson<LogSearchResult>(capped, "search_logs", { traceId });
        expect(result.lines).toHaveLength(2);
        expect(result).toMatchObject({ lineCount: 2, truncated: true, lineCap: 2 });
      } finally {
        await capped.close();
      }
    });

    it("rejects a malformed window or trace id", async () => {
      const since = await call(client, "search_logs", { since: "yesterday" });
      expect(since.isError).toBe(true);
      const id = await call(client, "search_logs", { traceId: "not-a-trace" });
      expect(id.isError).toBe(true);
    });
  });

  describe("get_trace", () => {
    it("returns the spans of the declined checkout", async () => {
      const trace = await pollUntil("the trace in Tempo", async () => {
        const reply = await call(client, "get_trace", { traceId });
        return reply.isError ? undefined : (JSON.parse(reply.text) as TraceSummary);
      });
      expect(trace).toMatchObject({
        traceId,
        rootSpan: `POST ${checkoutRoute}`,
        service: config.shopliteServiceName,
        route: checkoutRoute,
        method: "POST",
        statusCode: 402,
      });
      expect(trace.spanCount).toBeGreaterThan(3);
      expect(trace.spans).toHaveLength(trace.spanCount);
      const root = trace.spans[0];
      expect(root?.kind).toBe("server");
      expect(root?.parentSpanId).toBeUndefined();
      expect(root?.durationMs).toBeGreaterThan(0);
      expect(trace.spans.some((span) => span.name.startsWith("pg.query"))).toBe(true);
      const children = trace.spans.slice(1);
      expect(children.every((span) => span.parentSpanId !== undefined)).toBe(true);
      expect(JSON.stringify(trace)).not.toContain(declinedCard.number);
    });

    it("fails clearly for an unknown id", async () => {
      const reply = await call(client, "get_trace", { traceId: "0".repeat(32) });
      expect(reply.isError).toBe(true);
      expect(reply.text).toMatch(/no trace with id/i);
    });
  });

  describe("get_error_rate", () => {
    it(
      "is non-zero for the checkout route after the declined checkout",
      async () => {
        const rate = await pollUntil(
          "the 402 in Prometheus",
          async () => {
            const found = await callJson<ErrorRate>(client, "get_error_rate", {
              route: checkoutRoute,
              window: "10m",
            });
            return found.errors > 0 ? found : undefined;
          },
          metricsTimeoutMs,
        );
        expect(rate).toMatchObject({ route: checkoutRoute, window: "10m" });
        expect(rate.requests).toBeGreaterThanOrEqual(rate.errors);
        expect(rate.errorRate).toBeGreaterThan(0);
        expect(rate.errorRate).toBeLessThanOrEqual(1);
        expect(rate.byStatusCode["402"]).toBeGreaterThanOrEqual(1);
        expect(rate.serverErrorRate).toBeLessThanOrEqual(rate.errorRate);
      },
      metricsTimeoutMs + 10_000,
    );

    it(
      "counts at Sentinel's 60s window, which is only a few export intervals wide",
      async () => {
        await post(`/customers/${ava.id}/cart/items`, { productId: mug });
        const checkout = await post(`/customers/${ava.id}/checkout`, { card: declinedCard });
        expect(checkout.status).toBe(402);
        const rate = await pollUntil(
          "the fresh 402 inside a 60s window",
          async () => {
            const found = await callJson<ErrorRate>(client, "get_error_rate", {
              route: checkoutRoute,
              window: "60s",
            });
            return found.byStatusCode["402"] ? found : undefined;
          },
          metricsTimeoutMs,
        );
        expect(Number.isInteger(rate.requests)).toBe(true);
        expect(rate.errorRate).toBeGreaterThan(0);
      },
      metricsTimeoutMs + 10_000,
    );

    it("reports zero, not an error, for a route with no traffic", async () => {
      const rate = await callJson<ErrorRate>(client, "get_error_rate", {
        route: "/no/such/route",
        window: "5m",
      });
      expect(rate).toMatchObject({ requests: 0, errors: 0, errorRate: 0, byStatusCode: {} });
    });
  });

  describe("query_metrics", () => {
    it(
      "evaluates an instant query now",
      async () => {
        const result = await pollUntil(
          "checkout_errors_total in Prometheus",
          async () => {
            const found = await callJson<MetricsResult>(client, "query_metrics", {
              promql: `sum(checkout_errors_total{job="${config.shopliteServiceName}", reason="declined"})`,
            });
            return found.resultType === "vector" && found.samples.length > 0 ? found : undefined;
          },
          metricsTimeoutMs,
        );
        expect(result.resultType).toBe("vector");
        if (result.resultType !== "vector") return;
        expect(result.samples[0]?.value).toBeGreaterThanOrEqual(1);
        expect(result.samples[0]?.time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(result.truncated).toBe(false);
      },
      metricsTimeoutMs + 10_000,
    );

    it("returns each series over a window", async () => {
      const result = await callJson<MetricsResult>(client, "query_metrics", {
        promql: `sum(rate(http_server_request_duration_seconds_count{job="${config.shopliteServiceName}"}[1m]))`,
        window: "5m",
      });
      expect(result.resultType).toBe("matrix");
      if (result.resultType !== "matrix") return;
      expect(result.window).toBe("5m");
      expect(result.series).toHaveLength(1);
      const values = result.series[0]?.values ?? [];
      expect(values.length).toBeGreaterThan(1);
      expect(values.length).toBeLessThanOrEqual(31);
      expect(values[0]?.[0]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(typeof values[0]?.[1]).toBe("number");
    });

    it("passes Prometheus's parse error back", async () => {
      const reply = await call(client, "query_metrics", { promql: "sum(rate(" });
      expect(reply.isError).toBe(true);
      expect(reply.text).toContain("parse error");
    });
  });

  describe("list_recent_errors", () => {
    it(
      "brings the failing route, the checkout reason, and the grouped log lines together",
      async () => {
        const result = await pollUntil(
          "the decline in every signal",
          async () => {
            const found = await callJson<RecentErrorsResult>(client, "list_recent_errors", {
              since: "10m",
            });
            const routed = found.routes.some((route) => route.route === checkoutRoute);
            return routed && found.checkoutErrorsByReason.declined ? found : undefined;
          },
          metricsTimeoutMs,
        );
        const checkout = result.routes.find((route) => route.route === checkoutRoute);
        expect(checkout?.errors).toBeGreaterThanOrEqual(1);
        expect(checkout?.byStatusCode["402"]).toBeGreaterThanOrEqual(1);
        expect(result.checkoutErrorsByReason.declined).toBeGreaterThanOrEqual(1);

        const decline = result.messages.find((group) => group.message === declineLine);
        expect(decline?.level).toBe("warn");
        expect(decline?.count).toBeGreaterThanOrEqual(1);
        expect(decline?.traceIds).toContain(traceId);
        expect(decline?.traceIds.length).toBeLessThanOrEqual(5);
        expect(result.lines.every((line) => line.level !== "info")).toBe(true);
      },
      metricsTimeoutMs + 10_000,
    );
  });

  describe("redaction", () => {
    it("masks card numbers and every email for a tester Ticket", async () => {
      const tester = await startServer({ SHOPLITE_SERVICE_NAME: syntheticService });
      try {
        const result = await pollUntil("the synthetic line in Loki", async () => {
          const found = await callJson<LogSearchResult>(tester, "search_logs", {
            traceId: syntheticTraceId,
          });
          return found.lines.length > 0 ? found : undefined;
        });
        expect(result.lines[0]?.message).toBe(
          "card [redacted card] for [redacted email] and [redacted email] declined",
        );
      } finally {
        await tester.close();
      }
    });

    it("keeps the reporter's email for a customer Ticket and masks the rest", async () => {
      const customer = await startServer({
        SHOPLITE_SERVICE_NAME: syntheticService,
        REPORTER_EMAIL: ava.email,
      });
      try {
        const result = await callJson<LogSearchResult>(customer, "search_logs", {
          traceId: syntheticTraceId,
        });
        expect(result.lines[0]?.message).toBe(
          `card [redacted card] for [redacted email] and ${ava.email} declined`,
        );
      } finally {
        await customer.close();
      }
    });
  });
});
