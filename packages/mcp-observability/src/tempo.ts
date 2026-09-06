import { isoFromNanos } from "./time";

/**
 * The shape Tempo's `GET /api/traces/:id` returns: OTLP JSON with base64 ids, one batch
 * per resource. Only the fields read here are typed.
 */
export type OtlpAttribute = { key: string; value: OtlpValue };
export type OtlpValue = {
  stringValue?: string;
  intValue?: string;
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values: OtlpValue[] };
};
export type OtlpSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind?: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes?: OtlpAttribute[];
  status?: { code?: string; message?: string };
  events?: Array<{ timeUnixNano: string; name: string; attributes?: OtlpAttribute[] }>;
};
export type OtlpTrace = {
  batches: Array<{
    resource?: { attributes?: OtlpAttribute[] };
    scopeSpans: Array<{ scope?: { name?: string; version?: string }; spans: OtlpSpan[] }>;
  }>;
};

export type AttributeValue = string | number | boolean | AttributeValue[];

export type SpanSummary = {
  spanId: string;
  parentSpanId: string | undefined;
  name: string;
  kind: string;
  service: string | undefined;
  startTime: string;
  durationMs: number;
  status: "unset" | "ok" | "error";
  statusMessage?: string;
  attributes: Record<string, AttributeValue>;
  events?: Array<{ time: string; name: string; attributes: Record<string, AttributeValue> }>;
};

/** A span with the raw nanosecond bounds kept for ordering and duration arithmetic. */
type TimedSpan = SpanSummary & { startNanos: bigint; endNanos: bigint };

export type TraceSummary = {
  traceId: string;
  rootSpan: string | undefined;
  service: string | undefined;
  route: string | undefined;
  method: string | undefined;
  statusCode: number | undefined;
  startTime: string | undefined;
  durationMs: number | undefined;
  spanCount: number;
  /** Spans whose status is error, so a reader sees failures without scanning every span. */
  errors: Array<{ span: string; spanId: string; message: string | undefined }>;
  /** Every span in start order. */
  spans: SpanSummary[];
};

/** Reduces Tempo's OTLP JSON to what an investigator needs to read a request. */
export function summarizeTrace(traceId: string, trace: OtlpTrace): TraceSummary {
  const spans: TimedSpan[] = [];
  for (const batch of trace.batches) {
    const resource = attributesOf(batch.resource?.attributes);
    const service =
      typeof resource["service.name"] === "string" ? resource["service.name"] : undefined;
    for (const scope of batch.scopeSpans) {
      for (const span of scope.spans) spans.push(summarizeSpan(span, service));
    }
  }
  spans.sort((a, b) => (a.startNanos === b.startNanos ? 0 : a.startNanos < b.startNanos ? -1 : 1));

  const ids = new Set(spans.map((span) => span.spanId));
  const root =
    spans.find((span) => span.parentSpanId === undefined || !ids.has(span.parentSpanId)) ??
    spans[0];
  const routed = spans.find((span) => "http.route" in span.attributes);
  const first = spans[0];
  const endNanos = spans.reduce(
    (max, span) => (span.endNanos > max ? span.endNanos : max),
    first?.startNanos ?? 0n,
  );

  return {
    traceId,
    rootSpan: root?.name,
    service: root?.service,
    route: stringAttribute(routed, "http.route"),
    method:
      stringAttribute(root, "http.request.method") ??
      stringAttribute(routed, "http.request.method"),
    statusCode:
      numberAttribute(root, "http.response.status_code") ??
      numberAttribute(routed, "http.response.status_code"),
    startTime: first?.startTime,
    durationMs: first ? nanosToMs(endNanos - first.startNanos) : undefined,
    spanCount: spans.length,
    errors: spans
      .filter((span) => span.status === "error")
      .map((span) => ({ span: span.name, spanId: span.spanId, message: span.statusMessage })),
    spans: spans.map(({ startNanos: _s, endNanos: _e, ...span }) => span),
  };
}

function summarizeSpan(span: OtlpSpan, service: string | undefined): TimedSpan {
  const startNanos = BigInt(span.startTimeUnixNano);
  const endNanos = BigInt(span.endTimeUnixNano);
  const summary: TimedSpan = {
    spanId: hexFromBase64(span.spanId),
    parentSpanId: span.parentSpanId ? hexFromBase64(span.parentSpanId) : undefined,
    name: span.name,
    kind: (span.kind ?? "SPAN_KIND_UNSPECIFIED").replace("SPAN_KIND_", "").toLowerCase(),
    service,
    startTime: isoFromNanos(span.startTimeUnixNano),
    durationMs: nanosToMs(endNanos - startNanos),
    status: statusOf(span.status?.code),
    attributes: attributesOf(span.attributes),
    startNanos,
    endNanos,
  };
  if (span.status?.message) summary.statusMessage = span.status.message;
  if (span.events && span.events.length > 0) {
    summary.events = span.events.map((event) => ({
      time: isoFromNanos(event.timeUnixNano),
      name: event.name,
      attributes: attributesOf(event.attributes),
    }));
  }
  return summary;
}

function statusOf(code: string | undefined): SpanSummary["status"] {
  if (code === "STATUS_CODE_ERROR") return "error";
  if (code === "STATUS_CODE_OK") return "ok";
  return "unset";
}

function attributesOf(attributes: OtlpAttribute[] | undefined): Record<string, AttributeValue> {
  const result: Record<string, AttributeValue> = {};
  for (const { key, value } of attributes ?? []) {
    const plain = plainValue(value);
    if (plain !== undefined) result[key] = plain;
  }
  return result;
}

function plainValue(value: OtlpValue): AttributeValue | undefined {
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.intValue !== undefined) {
    // OTLP ints are 64-bit; one that does not fit a JS number stays a string so no digit is lost.
    const n = Number(value.intValue);
    return Number.isSafeInteger(n) ? n : value.intValue;
  }
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.boolValue !== undefined) return value.boolValue;
  if (value.arrayValue) {
    return value.arrayValue.values
      .map(plainValue)
      .filter((item): item is AttributeValue => item !== undefined);
  }
  return undefined;
}

function stringAttribute(span: SpanSummary | undefined, key: string): string | undefined {
  const value = span?.attributes[key];
  return typeof value === "string" ? value : undefined;
}

function numberAttribute(span: SpanSummary | undefined, key: string): number | undefined {
  const value = span?.attributes[key];
  return typeof value === "number" ? value : undefined;
}

/** A span duration in milliseconds, to the microsecond. */
function nanosToMs(nanos: bigint): number {
  return Number(nanos / 1_000n) / 1_000;
}

function hexFromBase64(value: string): string {
  return Buffer.from(value, "base64").toString("hex");
}

export type TempoClient = {
  /** The raw OTLP trace, or undefined when Tempo has no trace with that id. */
  getTrace(traceId: string): Promise<OtlpTrace | undefined>;
};

export function createTempoClient(baseUrl: string): TempoClient {
  return {
    async getTrace(traceId) {
      const response = await fetch(new URL(`/api/traces/${traceId}`, baseUrl));
      if (response.status === 404) return undefined;
      if (!response.ok) throw new Error(`Tempo: ${(await response.text()).trim()}`);
      return (await response.json()) as OtlpTrace;
    },
  };
}
