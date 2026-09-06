import { messageOf, redact } from "@incident-resolver/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { durationSchema } from "./duration";
import { buildLogQuery, flattenStreams, type LogEntry, type LokiClient, logLevels } from "./loki";
import {
  type ErrorRate,
  errorRateFrom,
  errorRateQuery,
  escapeLabelValue,
  type PrometheusClient,
  type PromSample,
} from "./prometheus";
import { summarizeTrace, type TempoClient, type TraceSummary } from "./tempo";

export type ObservabilityServerOptions = {
  loki: LokiClient;
  tempo: TempoClient;
  prometheus: PrometheusClient;
  /** ShopLite's service.name: Loki's `service_name` label and Prometheus's `job`. */
  serviceName: string;
  /** Lines a log search returns before being truncated. */
  lineCap: number;
  /** Present for customer Tickets: this email stays unmasked in log lines. */
  reporterEmail?: string | undefined;
};

export type LogSearchResult = {
  logql: string;
  since: string;
  lines: LogEntry[];
  lineCount: number;
  truncated: boolean;
  lineCap: number;
};

export type MetricsResult =
  | {
      promql: string;
      resultType: "vector";
      samples: Array<{ labels: Record<string, string>; time: string; value: number }>;
      seriesCount: number;
      truncated: boolean;
    }
  | {
      promql: string;
      window: string;
      resultType: "matrix";
      series: Array<{ labels: Record<string, string>; values: Array<[string, number]> }>;
      seriesCount: number;
      truncated: boolean;
    };

export type RecentErrorsResult = {
  since: string;
  /** Routes that returned a 4xx or 5xx in the window, worst first. */
  routes: ErrorRate[];
  /** ShopLite's checkout_errors_total by reason: declined, empty_cart, error. */
  checkoutErrorsByReason: Record<string, number>;
  /** Warn-and-above log lines grouped by message, most frequent first. */
  messages: Array<{
    level: string | undefined;
    message: string;
    count: number;
    traceIds: string[];
  }>;
  /** The newest warn-and-above lines, capped like search_logs. */
  lines: LogEntry[];
  truncated: boolean;
};

/** Series a metrics query returns before the rest are dropped. */
const seriesCap = 50;
/** Samples per series in a range query. */
const rangePoints = 30;
/** Trace ids per grouped message in list_recent_errors. */
const traceIdsPerMessage = 5;

const traceIdSchema = z
  .string()
  .regex(/^[0-9a-f]{32}$/i, "A trace id is 32 hex characters, as in the x-trace-id header")
  .transform((id) => id.toLowerCase());

/** Builds the `mcp-observability` server. Connect it to a transport to serve. */
export function createObservabilityServer(options: ObservabilityServerOptions): McpServer {
  const { loki, tempo, prometheus, serviceName, lineCap, reporterEmail } = options;
  const redacted = <T>(value: T): T => redact(value, { reporterEmail });
  const server = new McpServer({ name: "mcp-observability", version: "0.0.0" });

  async function searchLogs(input: {
    query?: string | undefined;
    since: string;
    level?: (typeof logLevels)[number] | undefined;
    traceId?: string | undefined;
  }): Promise<LogSearchResult> {
    const logql = buildLogQuery({ serviceName, ...input });
    const streams = await loki.queryRange(logql, input.since, lineCap + 1);
    const entries = flattenStreams(streams);
    return {
      logql,
      since: input.since,
      lines: entries.slice(0, lineCap),
      lineCount: Math.min(entries.length, lineCap),
      truncated: entries.length > lineCap,
      lineCap,
    };
  }

  server.registerTool(
    "search_logs",
    {
      title: "Search ShopLite logs",
      description:
        "Searches ShopLite's log lines in Loki over the last `since`, newest first. Give free text to match " +
        "in the line, a level to see that level and above, a trace id to see every line of one request, or " +
        `any combination. At most ${lineCap} lines come back, and card numbers and other people's emails ` +
        "are masked. Each line carries its trace id, so a hit can be followed with get_trace.",
      inputSchema: {
        query: z.string().optional().describe("Text to find in the line, case-insensitive"),
        since: durationSchema
          .default("1h")
          .describe("How far back to look, such as 15m, 1h, or 1d"),
        level: z.enum(logLevels).optional().describe("Lowest level to include"),
        traceId: traceIdSchema.optional().describe("Only lines from this request"),
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      try {
        return text(redacted(await searchLogs(input)));
      } catch (error) {
        return failure(`Log search failed: ${redacted(messageOf(error))}`);
      }
    },
  );

  server.registerTool(
    "get_trace",
    {
      title: "Get a ShopLite trace",
      description:
        "Fetches one request's trace from Tempo by the id in its x-trace-id header, an error toast, or a " +
        "log line. Returns the root span, route, status code, every span in start order with its " +
        "attributes, and any spans that ended in error with their exception events.",
      inputSchema: { traceId: traceIdSchema.describe("The 32-character trace id") },
      annotations: { readOnlyHint: true },
    },
    async ({ traceId }) => {
      try {
        const trace = await tempo.getTrace(traceId);
        if (!trace) {
          return failure(
            `No trace with id ${traceId}. A request from the last few seconds may not be indexed yet.`,
          );
        }
        const summary: TraceSummary = summarizeTrace(traceId, trace);
        return text(redacted(summary));
      } catch (error) {
        return failure(`Trace lookup failed: ${redacted(messageOf(error))}`);
      }
    },
  );

  server.registerTool(
    "query_metrics",
    {
      title: "Query ShopLite metrics",
      description:
        "Runs a PromQL query against Prometheus. Without a window it is evaluated now and returns one " +
        `sample per series; with a window it returns each series over that window with about ${rangePoints} ` +
        `points. ShopLite's series carry job="${serviceName}". Useful metrics: ` +
        "http_server_request_duration_seconds_count by http_route and http_response_status_code, " +
        "checkout_total, checkout_errors_total by reason, discount_applied_total by code. For a route's " +
        "error ratio prefer get_error_rate.",
      inputSchema: {
        promql: z.string().min(1).describe("The PromQL expression"),
        window: durationSchema
          .optional()
          .describe("Return the series over this window, such as 5m or 1h"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ promql, window }) => {
      try {
        return text(redacted(await queryMetrics(prometheus, promql, window)));
      } catch (error) {
        return failure(`Metrics query failed: ${redacted(messageOf(error))}`);
      }
    },
  );

  server.registerTool(
    "get_error_rate",
    {
      title: "Get a route's error rate",
      description:
        "The share of one ShopLite route's responses that were errors over the window, from Prometheus. " +
        "errorRate counts every 4xx and 5xx, so a declined card (402) counts; serverErrorRate counts 5xx " +
        "only. Routes are Fastify patterns such as /customers/:customerId/checkout. Counts are per status " +
        "code so the two can be told apart.",
      inputSchema: {
        route: z
          .string()
          .min(1)
          .describe("The route pattern, such as /customers/:customerId/checkout"),
        window: durationSchema
          .default("5m")
          .describe("How far back to count, such as 1m, 5m, or 1h"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ route, window }) => {
      try {
        const vector = await prometheus.query(errorRateQuery({ job: serviceName, route, window }));
        return text(redacted(errorRateFrom({ route, window }, vector)));
      } catch (error) {
        return failure(`Error rate query failed: ${redacted(messageOf(error))}`);
      }
    },
  );

  server.registerTool(
    "list_recent_errors",
    {
      title: "List recent ShopLite errors",
      description:
        "What has gone wrong recently, from every signal at once: routes that returned 4xx or 5xx over " +
        "the last `since` with their error rates, failed checkouts by reason, and the warn-and-above log " +
        "lines grouped by message with trace ids to follow. Start here for a Ticket with no trace id, or " +
        "to see whether one customer's problem is everyone's problem.",
      inputSchema: {
        since: durationSchema
          .default("15m")
          .describe("How far back to look, such as 5m, 15m, or 1h"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ since }) => {
      try {
        const job = escapeLabelValue(serviceName);
        const [byRoute, byReason, logs] = await Promise.all([
          prometheus.query(
            "sum by (http_route, http_response_status_code) " +
              `(increase(http_server_request_duration_seconds_count{job="${job}"}[${since}]))`,
          ),
          prometheus.query(
            `sum by (reason) (increase(checkout_errors_total{job="${job}"}[${since}]))`,
          ),
          searchLogs({ since, level: "warn" }),
        ]);
        const result: RecentErrorsResult = {
          since,
          routes: routesWithErrors(byRoute, since),
          checkoutErrorsByReason: countsBy(byReason, "reason"),
          messages: groupMessages(logs.lines),
          lines: logs.lines,
          truncated: logs.truncated,
        };
        return text(redacted(result));
      } catch (error) {
        return failure(`Listing recent errors failed: ${redacted(messageOf(error))}`);
      }
    },
  );

  return server;
}

async function queryMetrics(
  prometheus: PrometheusClient,
  promql: string,
  window: string | undefined,
): Promise<MetricsResult> {
  if (window === undefined) {
    const vector = await prometheus.query(promql);
    return {
      promql,
      resultType: "vector",
      samples: vector.slice(0, seriesCap).map((sample) => ({
        labels: sample.metric,
        time: new Date(sample.value[0] * 1000).toISOString(),
        value: Number(sample.value[1]),
      })),
      seriesCount: Math.min(vector.length, seriesCap),
      truncated: vector.length > seriesCap,
    };
  }
  const matrix = await prometheus.queryRange(promql, window, rangePoints);
  return {
    promql,
    window,
    resultType: "matrix",
    series: matrix.slice(0, seriesCap).map((series) => ({
      labels: series.metric,
      values: series.values.map(([time, value]) => [
        new Date(time * 1000).toISOString(),
        Number(value),
      ]),
    })),
    seriesCount: Math.min(matrix.length, seriesCap),
    truncated: matrix.length > seriesCap,
  };
}

/** Error rates per route from a vector grouped by route and status code, worst first. */
function routesWithErrors(vector: PromSample[], window: string): ErrorRate[] {
  const byRoute = new Map<string, PromSample[]>();
  for (const sample of vector) {
    const route = sample.metric.http_route || "(unrouted)";
    byRoute.set(route, [...(byRoute.get(route) ?? []), sample]);
  }
  return [...byRoute]
    .map(([route, samples]) => errorRateFrom({ route, window }, samples))
    .filter((rate) => rate.errors > 0)
    .sort((a, b) => b.errorRate - a.errorRate || b.errors - a.errors);
}

function countsBy(vector: PromSample[], label: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const sample of vector) {
    const key = sample.metric[label];
    const count = Math.round(Number(sample.value[1]));
    if (key && count > 0) counts[key] = count;
  }
  return counts;
}

function groupMessages(lines: LogEntry[]): RecentErrorsResult["messages"] {
  const groups = new Map<string, RecentErrorsResult["messages"][number]>();
  for (const line of lines) {
    const key = `${line.level} ${line.message}`;
    const group = groups.get(key) ?? {
      level: line.level,
      message: line.message,
      count: 0,
      traceIds: [],
    };
    group.count += 1;
    const { traceId } = line;
    if (
      traceId &&
      group.traceIds.length < traceIdsPerMessage &&
      !group.traceIds.includes(traceId)
    ) {
      group.traceIds.push(traceId);
    }
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

function text(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function failure(reason: string): CallToolResult {
  return { content: [{ type: "text", text: reason }], isError: true };
}
