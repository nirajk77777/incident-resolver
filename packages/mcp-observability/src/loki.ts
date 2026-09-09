import { quoted } from "./escape";
import { isoFromNanos, parseDuration } from "./time";

/** Log levels a search can ask for. A level means that level and above. */
export const logLevels = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof logLevels)[number];

/** Loki's `detected_level` values, least to most severe. */
const severityOrder = ["debug", "info", "warn", "error", "fatal"] as const;

export type LogQueryInput = {
  serviceName: string;
  level?: LogLevel | undefined;
  traceId?: string | undefined;
};

/**
 * Builds the LogQL for a search: the service's stream, narrowed by level and trace id. Free
 * text is not in it. A LogQL line filter sees only the message, and what a Reporter names —
 * an order id, a discount code, a product — is a field pino attached to the line, which Loki
 * keeps as structured metadata beside it. So the text is matched here, by `matchesQuery`,
 * over the message and the fields together.
 */
export function buildLogQuery(input: LogQueryInput): string {
  const stages = [`{service_name=${quoted(input.serviceName)}}`];
  if (input.level) {
    const from = severityOrder.indexOf(input.level);
    stages.push(`| detected_level=~${quoted(severityOrder.slice(from).join("|"))}`);
  }
  if (input.traceId) stages.push(`| trace_id=${quoted(input.traceId)}`);
  return stages.join(" ");
}

/** One stream from Loki's `query_range` response: shared labels plus `[nanos, line]` pairs. */
export type LokiStream = {
  stream: Record<string, string>;
  values: Array<[string, string]>;
};

/** A log line as the agent sees it. */
export type LogEntry = {
  timestamp: string;
  level: string | undefined;
  message: string;
  traceId: string | undefined;
  spanId: string | undefined;
  /** The structured fields pino attached to the line, minus resource and SDK noise. */
  fields: Record<string, string>;
};

/** Keys the OTel resource and the pino bridge stamp on every line, of no use to a reader. */
const noisePrefixes = ["host_", "process_", "telemetry_sdk_", "scope_", "service_"];
const noiseKeys = new Set([
  "detected_level",
  "severity_text",
  "severity_number",
  "trace_id",
  "span_id",
  "flags",
  "observed_timestamp",
]);

/**
 * Whether a line is about the text: it appears, case-insensitively, in the message or in any
 * field's key or value. No text matches every line.
 */
export function matchesQuery(entry: LogEntry, query: string | undefined): boolean {
  const needle = query?.trim().toLowerCase();
  if (!needle) return true;
  if (entry.message.toLowerCase().includes(needle)) return true;
  return Object.entries(entry.fields).some(
    ([key, value]) => key.toLowerCase().includes(needle) || value.toLowerCase().includes(needle),
  );
}

/** Turns Loki streams into a flat list of entries, newest first. */
export function flattenStreams(streams: LokiStream[]): LogEntry[] {
  const entries: Array<LogEntry & { nanos: bigint }> = [];
  for (const { stream, values } of streams) {
    const fields = Object.fromEntries(
      Object.entries(stream).filter(
        ([key]) => !noiseKeys.has(key) && !noisePrefixes.some((prefix) => key.startsWith(prefix)),
      ),
    );
    for (const [nanos, message] of values) {
      entries.push({
        nanos: BigInt(nanos),
        timestamp: isoFromNanos(nanos),
        level: stream.detected_level ?? stream.severity_text,
        message,
        traceId: stream.trace_id,
        spanId: stream.span_id,
        fields,
      });
    }
  }
  entries.sort((a, b) => (a.nanos === b.nanos ? 0 : a.nanos > b.nanos ? -1 : 1));
  return entries.map(({ nanos: _, ...entry }) => entry);
}

export type LokiClient = {
  /** Runs a LogQL query over the last `since`, returning at most `limit` lines, newest first. */
  queryRange(logql: string, since: string, limit: number): Promise<LokiStream[]>;
};

export function createLokiClient(baseUrl: string): LokiClient {
  return {
    async queryRange(logql, since, limit) {
      const end = Date.now();
      const start = end - parseDuration(since);
      const url = new URL("/loki/api/v1/query_range", baseUrl);
      url.searchParams.set("query", logql);
      url.searchParams.set("start", `${BigInt(start) * 1_000_000n}`);
      url.searchParams.set("end", `${BigInt(end) * 1_000_000n}`);
      url.searchParams.set("limit", String(limit));
      url.searchParams.set("direction", "backward");
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Loki: ${(await response.text()).trim()}`);
      const body = (await response.json()) as {
        data: { resultType: string; result: LokiStream[] };
      };
      if (body.data.resultType !== "streams") {
        throw new Error(`Loki returned ${body.data.resultType}, not log streams`);
      }
      return body.data.result;
    },
  };
}
