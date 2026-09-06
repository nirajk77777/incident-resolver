import type { ErrorRate } from "@incident-resolver/mcp-observability";

/**
 * Sentinel's rule, and nothing else. Deciding whether a route is in trouble is arithmetic on
 * numbers Prometheus already has, so it is settled here rather than by a model: a model is
 * asked only to put the finding into words.
 */

export type SentinelThresholds = {
  /** A route's server-error ratio has to exceed this. Config's `SENTINEL_ERROR_RATIO`. */
  errorRatio: number;
  /** How far back the ratio is counted. Config's `SENTINEL_WINDOW_SECONDS`. */
  windowSeconds: number;
  /** Requests the window needs before a ratio means anything. Config's `SENTINEL_MIN_REQUESTS`. */
  minRequests: number;
};

/** A route that broke the rule, with the numbers that say so. */
export type Anomaly = {
  route: string;
  /**
   * Sentinel's key for the problem: the route and how it is failing. Two detections of one
   * spike carry the same fingerprint, which is how the portal keeps them one Ticket.
   */
  fingerprint: string;
  errorType: string;
  window: string;
  requests: number;
  serverErrors: number;
  serverErrorRate: number;
  byStatusCode: Record<string, number>;
};

/** The window as PromQL and as prose: `60s`. */
export const windowOf = (thresholds: SentinelThresholds) => `${thresholds.windowSeconds}s`;

/**
 * How the route is failing, as the status code most of its failures came back as. Successes
 * are ignored, so a route that is mostly fine but crashes for some people is still keyed on
 * the crash. `http_error` when nothing failed, which the rule never lets through anyway.
 */
export function dominantErrorType(byStatusCode: Record<string, number>): string {
  let worst: { code: string; count: number } | undefined;
  for (const [code, count] of Object.entries(byStatusCode)) {
    if (Number(code) < 400) continue;
    if (!worst || count > worst.count) worst = { code, count };
  }
  return worst ? `http_${worst.code}` : "http_error";
}

/** The key a problem is known by, so the same problem seen twice is one Ticket. */
export function fingerprintOf(route: string, errorType: string): string {
  return `${route}:${errorType}`;
}

/**
 * The routes in trouble, worst first. The ratio thresholded is the server-error one: a
 * declined card is a 402 and is the customer's problem, not an outage, so only 5xx counts
 * as the route failing. Below `minRequests` nothing is reported, since one failure out of
 * two is a ratio of 0.5 and means nothing.
 */
export function anomaliesIn(rates: ErrorRate[], thresholds: SentinelThresholds): Anomaly[] {
  return rates
    .filter(
      (rate) =>
        rate.requests >= thresholds.minRequests && rate.serverErrorRate > thresholds.errorRatio,
    )
    .map((rate) => {
      const errorType = dominantErrorType(rate.byStatusCode);
      return {
        route: rate.route,
        fingerprint: fingerprintOf(rate.route, errorType),
        errorType,
        window: rate.window,
        requests: rate.requests,
        serverErrors: rate.serverErrors,
        serverErrorRate: rate.serverErrorRate,
        byStatusCode: rate.byStatusCode,
      };
    })
    .sort((a, b) => b.serverErrorRate - a.serverErrorRate || b.serverErrors - a.serverErrors);
}
