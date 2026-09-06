import { describe, expect, it } from "vitest";
import { type OtlpTrace, summarizeTrace } from "./tempo";

// Trimmed from a real declined checkout in the LGTM container. Ids are base64 as
// Tempo's JSON gateway renders them.
const traceId = "ad14aad0456c157431dce7b3c79df366";
const trace: OtlpTrace = {
  batches: [
    {
      resource: {
        attributes: [
          { key: "service.name", value: { stringValue: "shoplite-api" } },
          { key: "host.name", value: { stringValue: "Mac" } },
          { key: "process.pid", value: { intValue: "13321" } },
        ],
      },
      scopeSpans: [
        {
          scope: { name: "@opentelemetry/instrumentation-http", version: "0.1" },
          spans: [
            {
              traceId: "rRSq0EVsFXQx3Oezx53zZg==",
              spanId: "lx/ErFIe79Y=",
              name: "POST /customers/:customerId/checkout",
              kind: "SPAN_KIND_SERVER",
              startTimeUnixNano: "1788693091055000000",
              endTimeUnixNano: "1788693091061000000",
              attributes: [
                { key: "http.request.method", value: { stringValue: "POST" } },
                { key: "http.route", value: { stringValue: "/customers/:customerId/checkout" } },
                { key: "http.response.status_code", value: { intValue: "402" } },
                { key: "url.path", value: { stringValue: "/customers/0000/checkout" } },
                { key: "client.address", value: { stringValue: "127.0.0.1" } },
                { key: "user_agent.original", value: { stringValue: "curl/8" } },
              ],
              status: {},
            },
          ],
        },
        {
          scope: { name: "@fastify/otel", version: "0.20.1" },
          spans: [
            {
              traceId: "rRSq0EVsFXQx3Oezx53zZg==",
              spanId: "Tf23d4zE2A0=",
              parentSpanId: "lx/ErFIe79Y=",
              name: "request",
              kind: "SPAN_KIND_INTERNAL",
              startTimeUnixNano: "1788693091056000000",
              endTimeUnixNano: "1788693091060180167",
              attributes: [
                { key: "fastify.root", value: { stringValue: "@fastify/otel" } },
                { key: "http.route", value: { stringValue: "/customers/:customerId/checkout" } },
                { key: "http.response.status_code", value: { intValue: "402" } },
              ],
              status: {},
            },
            {
              traceId: "rRSq0EVsFXQx3Oezx53zZg==",
              spanId: "B0JKKaVBaUM=",
              parentSpanId: "Tf23d4zE2A0=",
              name: "handler - checkoutRoutes",
              kind: "SPAN_KIND_INTERNAL",
              startTimeUnixNano: "1788693091056000000",
              endTimeUnixNano: "1788693091059998250",
              attributes: [{ key: "fastify.type", value: { stringValue: "request-handler" } }],
              status: { code: "STATUS_CODE_ERROR", message: "boom" },
              events: [
                {
                  timeUnixNano: "1788693091059000000",
                  name: "exception",
                  attributes: [
                    { key: "exception.type", value: { stringValue: "Error" } },
                    { key: "exception.message", value: { stringValue: "boom" } },
                    { key: "exception.stacktrace", value: { stringValue: "Error: boom\n at x" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    {
      resource: { attributes: [{ key: "service.name", value: { stringValue: "shoplite-api" } }] },
      scopeSpans: [
        {
          scope: { name: "@opentelemetry/instrumentation-pg", version: "0.74.0" },
          spans: [
            {
              traceId: "rRSq0EVsFXQx3Oezx53zZg==",
              spanId: "RVVW2+iAjYI=",
              parentSpanId: "B0JKKaVBaUM=",
              name: "pg.query:SELECT incident_resolver",
              kind: "SPAN_KIND_CLIENT",
              startTimeUnixNano: "1788693091057000000",
              endTimeUnixNano: "1788693091058000000",
              attributes: [
                { key: "db.system.name", value: { stringValue: "postgresql" } },
                { key: "db.query.text", value: { stringValue: "select 1" } },
                { key: "server.port", value: { intValue: "5432" } },
                { key: "db.ok", value: { boolValue: true } },
                { key: "db.ratio", value: { doubleValue: 0.5 } },
                { key: "db.tags", value: { arrayValue: { values: [{ stringValue: "a" }] } } },
                { key: "db.big", value: { intValue: "4242424242424242424" } },
              ],
              status: {},
            },
          ],
        },
      ],
    },
  ],
};

describe("summarizeTrace", () => {
  const summary = summarizeTrace(traceId, trace);

  it("names the root span, the route, the status, and the total duration", () => {
    expect(summary).toMatchObject({
      traceId,
      rootSpan: "POST /customers/:customerId/checkout",
      service: "shoplite-api",
      route: "/customers/:customerId/checkout",
      method: "POST",
      statusCode: 402,
      startTime: "2026-09-06T11:11:31.055Z",
      durationMs: 6,
      spanCount: 4,
    });
  });

  it("lists spans in start order with hex ids, parents, and their attributes", () => {
    expect(summary.spans.map((span) => span.name)).toEqual([
      "POST /customers/:customerId/checkout",
      "request",
      "handler - checkoutRoutes",
      "pg.query:SELECT incident_resolver",
    ]);
    const [root, , handler, pg] = summary.spans;
    expect(root).toMatchObject({
      spanId: "971fc4ac521eefd6",
      parentSpanId: undefined,
      kind: "server",
      service: "shoplite-api",
      durationMs: 6,
      status: "unset",
    });
    expect(root?.attributes).toEqual({
      "http.request.method": "POST",
      "http.route": "/customers/:customerId/checkout",
      "http.response.status_code": 402,
      "url.path": "/customers/0000/checkout",
      "client.address": "127.0.0.1",
      "user_agent.original": "curl/8",
    });
    expect(handler).toMatchObject({
      spanId: "07424a29a5416943",
      parentSpanId: "4dfdb7778cc4d80d",
      status: "error",
      statusMessage: "boom",
      durationMs: 3.998,
    });
    expect(pg?.attributes).toEqual({
      "db.system.name": "postgresql",
      "db.query.text": "select 1",
      "server.port": 5432,
      "db.ok": true,
      "db.ratio": 0.5,
      "db.tags": ["a"],
      "db.big": "4242424242424242424",
    });
  });

  it("surfaces exception events and error spans so the reader does not have to hunt", () => {
    expect(summary.spans[2]?.events).toEqual([
      {
        time: "2026-09-06T11:11:31.059Z",
        name: "exception",
        attributes: {
          "exception.type": "Error",
          "exception.message": "boom",
          "exception.stacktrace": "Error: boom\n at x",
        },
      },
    ]);
    expect(summary.errors).toEqual([
      { span: "handler - checkoutRoutes", spanId: "07424a29a5416943", message: "boom" },
    ]);
  });

  it("handles a trace with no spans", () => {
    expect(summarizeTrace(traceId, { batches: [] })).toMatchObject({
      traceId,
      rootSpan: undefined,
      spanCount: 0,
      spans: [],
      errors: [],
    });
  });
});
