import {
  buildLogQuery,
  flattenStreams,
  type LogEntry,
  type LokiClient,
} from "@incident-resolver/mcp-observability";

/**
 * What Sentinel attaches to the Ticket it opens: trace ids to follow, so the Log
 * Investigator starts on a real request rather than on a search, and the messages behind
 * them. Metrics say a route is failing; only the logs say what it said while failing.
 *
 * These are the service's warn-and-above lines from the window the spike was measured over,
 * not that route's alone: a ShopLite log line carries the request's trace id but not the
 * route pattern the metric is keyed on, so there is nothing honest to narrow by. During a
 * spike they are overwhelmingly the spike, and the Ticket says only that they are what was
 * being logged at the time. The Log Investigator is the one that establishes which request
 * is which.
 */
export type Evidence = {
  /** Trace ids to follow, newest first. */
  traceIds: string[];
  /** The distinct messages in the window, most frequent first. */
  messages: Array<{
    level: string | undefined;
    message: string;
    count: number;
    traceIds: string[];
  }>;
};

/** Trace ids on the Ticket. Enough to follow, few enough that the body stays readable. */
const traceIdCap = 5;
/** Distinct messages on the Ticket. */
const messageCap = 5;
/** Lines asked of Loki. Well above the cap, so the counts are real. */
const lineCap = 200;

/** Groups lines into the shape the Ticket carries. Lines arrive newest first and stay that way. */
export function summarizeLines(lines: LogEntry[]): Evidence {
  const groups = new Map<string, Evidence["messages"][number]>();
  const traceIds: string[] = [];
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
    if (traceId) {
      if (group.traceIds.length < traceIdCap && !group.traceIds.includes(traceId)) {
        group.traceIds.push(traceId);
      }
      if (traceIds.length < traceIdCap && !traceIds.includes(traceId)) traceIds.push(traceId);
    }
    groups.set(key, group);
  }
  return {
    traceIds,
    messages: [...groups.values()].sort((a, b) => b.count - a.count).slice(0, messageCap),
  };
}

export type EvidenceQuery = {
  serviceName: string;
  /** How far back to read, the same window the ratio was counted over. */
  since: string;
};

/**
 * Reads the service's warn-and-above lines for the window out of Loki. The window is the one
 * the spike was measured over, so what comes back is what was being logged while the route
 * was failing. A Loki that cannot be reached leaves the Ticket without trace ids rather than
 * unopened: the metric alone is worth telling someone about.
 */
export async function gatherEvidence(loki: LokiClient, query: EvidenceQuery): Promise<Evidence> {
  const logql = buildLogQuery({ serviceName: query.serviceName, level: "warn" });
  const streams = await loki.queryRange(logql, query.since, lineCap);
  return summarizeLines(flattenStreams(streams));
}
