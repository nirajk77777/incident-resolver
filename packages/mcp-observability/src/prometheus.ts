import { parseDuration } from "./duration";

/** One sample of an instant query: labels plus `[unix seconds, value]`. */
export type PromSample = { metric: Record<string, string>; value: [number, string] };
export type PromVector = PromSample[];
/** One series of a range query: labels plus `[unix seconds, value]` pairs. */
export type PromSeries = { metric: Record<string, string>; values: Array<[number, string]> };

export function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export type ErrorRateInput = { route: string; window: string };

/** Requests to one route over the window, split by status code, from the OTel HTTP histogram. */
export function errorRateQuery(input: ErrorRateInput & { job: string }): string {
  const selector = `job="${escapeLabelValue(input.job)}", http_route="${escapeLabelValue(input.route)}"`;
  return `sum by (http_response_status_code) (increase(http_server_request_duration_seconds_count{${selector}}[${input.window}]))`;
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

/**
 * Turns the per-status-code vector into counts and ratios. `increase()` extrapolates, so a
 * single request comes back as roughly 1.02; the counts are rounded since they are integers
 * in reality.
 */
export function errorRateFrom(input: ErrorRateInput, vector: PromVector): ErrorRate {
  const byStatusCode: Record<string, number> = {};
  let requests = 0;
  let errors = 0;
  let serverErrors = 0;
  for (const sample of vector) {
    const code = sample.metric.http_response_status_code;
    if (!code) continue;
    const count = Math.round(Number(sample.value[1]));
    byStatusCode[code] = count;
    requests += count;
    if (code >= "400") errors += count;
    if (code >= "500") serverErrors += count;
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
