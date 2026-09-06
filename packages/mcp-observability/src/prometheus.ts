import { escapeLabelValue } from "./escape";
import { parseDuration } from "./time";

/** One sample of an instant query: labels plus `[unix seconds, value]`. */
export type PromSample = { metric: Record<string, string>; value: [number, string] };
export type PromVector = PromSample[];
/** One series of a range query: labels plus `[unix seconds, value]` pairs. */
export type PromSeries = { metric: Record<string, string>; values: Array<[number, string]> };

export type ErrorRateInput = { route: string; window: string };

/**
 * Requests to one route over the window, split by status code, from the OTel HTTP histogram.
 * The count is the counter now minus the counter at the start of the window, so it is exact
 * and works down to one export interval, where `increase()` would need two samples inside
 * the window and extrapolate. A series younger than the window counts in full, and a
 * counter reset counts as zero.
 */
export function errorRateQuery(input: ErrorRateInput & { job: string }): string {
  const counter = requestCounter(input.job, input.route);
  return `sum by (http_response_status_code) (${countOverWindow(counter, input.window)})`;
}

/** The same growth over the window for every route of the job, split by route and status code. */
export function errorRateByRouteQuery(job: string, window: string): string {
  return `sum by (http_route, http_response_status_code) (${countOverWindow(requestCounter(job), window)})`;
}

/** Checkout failures by reason over the window, from ShopLite's checkout_errors_total. */
export function checkoutErrorsQuery(job: string, window: string): string {
  const counter = `checkout_errors_total{job="${escapeLabelValue(job)}"}`;
  return `sum by (reason) (${countOverWindow(counter, window)})`;
}

function requestCounter(job: string, route?: string): string {
  const routeMatcher = route === undefined ? "" : `, http_route="${escapeLabelValue(route)}"`;
  return `http_server_request_duration_seconds_count{job="${escapeLabelValue(job)}"${routeMatcher}}`;
}

function countOverWindow(counter: string, window: string): string {
  return `clamp_min((${counter} - (${counter} offset ${window})) or ${counter}, 0)`;
}

export type ErrorRate = {
  route: string;
  window: string;
  requests: number;
  /** Responses with a 4xx or 5xx status. A declined card is a 402, so it counts here. */
  errors: number;
  /** Responses with a 5xx status only: crashes and upstream failures. */
  serverErrors: number;
  errorRate: number;
  serverErrorRate: number;
  byStatusCode: Record<string, number>;
};

/** Turns the per-status-code vector into counts and ratios. Counts are integers in reality, so they are rounded. */
export function errorRateFrom(input: ErrorRateInput, vector: PromVector): ErrorRate {
  const byStatusCode: Record<string, number> = {};
  let requests = 0;
  let errors = 0;
  let serverErrors = 0;
  for (const sample of vector) {
    const code = sample.metric.http_response_status_code;
    if (!code) continue;
    const count = Math.round(Number(sample.value[1]));
    const status = Number(code);
    byStatusCode[code] = count;
    requests += count;
    if (status >= 400) errors += count;
    if (status >= 500) serverErrors += count;
  }
  const ratio = (n: number) => (requests === 0 ? 0 : round(n / requests));
  return {
    route: input.route,
    window: input.window,
    requests,
    errors,
    serverErrors,
    errorRate: ratio(errors),
    serverErrorRate: ratio(serverErrors),
    byStatusCode,
  };
}

/**
 * Error rates per route from a vector grouped by route and status code, worst first. Routes
 * with no errors are dropped: the callers — the agent listing what has gone wrong, and
 * Sentinel watching for a spike — both only ever ask about the ones that are failing.
 */
export function errorRatesByRoute(vector: PromVector, window: string): ErrorRate[] {
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

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export type PrometheusClient = {
  /** An instant query evaluated now. */
  query(promql: string): Promise<PromVector>;
  /** A range query over the last `window`, with at most `points` samples per series. */
  queryRange(promql: string, window: string, points: number): Promise<PromSeries[]>;
};

export function createPrometheusClient(baseUrl: string): PrometheusClient {
  async function get<T>(path: string, params: Record<string, string>): Promise<T> {
    const url = new URL(path, baseUrl);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const response = await fetch(url);
    // Prometheus answers a bad query with JSON and a 4xx; anything else, such as a proxy's
    // 502 page, is reported by status rather than as a JSON parse failure.
    const isJson = response.headers.get("content-type")?.includes("application/json") ?? false;
    if (!isJson) {
      throw new Error(`Prometheus: ${response.status} ${(await response.text()).trim()}`);
    }
    const body = (await response.json()) as
      | { status: "success"; data: { resultType: string; result: T } }
      | { status: "error"; error: string };
    if (body.status !== "success") throw new Error(`Prometheus: ${body.error}`);
    return body.data.result;
  }

  return {
    query(promql) {
      return get<PromVector>("/api/v1/query", { query: promql });
    },
    queryRange(promql, window, points) {
      const end = Date.now() / 1000;
      const seconds = parseDuration(window) / 1000;
      const step = Math.max(1, Math.ceil(seconds / points));
      return get<PromSeries[]>("/api/v1/query_range", {
        query: promql,
        start: String(end - seconds),
        end: String(end),
        step: String(step),
      });
    },
  };
}
