import { describe, expect, it } from "vitest";
import { buildLogQuery, flattenStreams, type LokiStream } from "./loki";

const service = "shoplite-api";

describe("buildLogQuery", () => {
  it("selects the service stream and nothing else when there are no filters", () => {
    expect(buildLogQuery({ serviceName: service })).toBe('{service_name="shoplite-api"}');
  });

  it("filters by trace id through the structured metadata pino attached", () => {
    expect(
      buildLogQuery({ serviceName: service, traceId: "ad14aad0456c157431dce7b3c79df366" }),
    ).toBe('{service_name="shoplite-api"} | trace_id="ad14aad0456c157431dce7b3c79df366"');
  });

  it("treats a level as that level and above", () => {
    expect(buildLogQuery({ serviceName: service, level: "warn" })).toBe(
      '{service_name="shoplite-api"} | detected_level=~"warn|error|fatal"',
    );
    expect(buildLogQuery({ serviceName: service, level: "error" })).toBe(
      '{service_name="shoplite-api"} | detected_level=~"error|fatal"',
    );
    expect(buildLogQuery({ serviceName: service, level: "debug" })).toContain(
      'detected_level=~"debug|info|warn|error|fatal"',
    );
  });

  it("matches the text case-insensitively and escapes regex metacharacters and quotes", () => {
    expect(buildLogQuery({ serviceName: service, query: 'declined (gateway) "x"' })).toBe(
      '{service_name="shoplite-api"} |~ "(?i)declined \\\\(gateway\\\\) \\"x\\""',
    );
  });

  it("puts the line filter before the label filters and ignores blank text", () => {
    expect(
      buildLogQuery({ serviceName: service, query: "  declined ", level: "warn", traceId: "abc" }),
    ).toBe(
      '{service_name="shoplite-api"} |~ "(?i)declined" | detected_level=~"warn|error|fatal" | trace_id="abc"',
    );
    expect(buildLogQuery({ serviceName: service, query: "   " })).toBe(
      '{service_name="shoplite-api"}',
    );
  });

  it("escapes a service name with quotes so a label selector cannot be broken out of", () => {
    expect(buildLogQuery({ serviceName: 'a"b' })).toBe('{service_name="a\\"b"}');
  });
});

describe("flattenStreams", () => {
  const streams: LokiStream[] = [
    {
      stream: {
        service_name: service,
        service_instance_id: "i1",
        detected_level: "warn",
        severity_text: "warn",
        severity_number: "13",
        trace_id: "ad14aad0456c157431dce7b3c79df366",
        span_id: "07424a29a5416943",
        flags: "1",
        observed_timestamp: "1788693091060000000",
        host_name: "Mac",
        host_arch: "arm64",
        process_pid: "13321",
        process_command_args: "[...]",
        telemetry_sdk_name: "opentelemetry",
        scope_name: "@opentelemetry/instrumentation-pino",
        reqId: "req-s",
        declineCode: "insufficient_funds",
        customerId: "00000000-0000-4000-8000-000000000001",
      },
      values: [["1788693091060000000", "payment declined by gateway: insufficient_funds"]],
    },
    {
      stream: {
        service_name: service,
        detected_level: "info",
        severity_text: "info",
        trace_id: "ad14aad0456c157431dce7b3c79df366",
        span_id: "971fc4ac521eefd6",
        reqId: "req-s",
      },
      values: [
        ["1788693091055000000", "incoming request"],
        ["1788693091062000000", "request completed"],
      ],
    },
  ];

  it("returns one entry per line, newest first, with the useful fields and no resource noise", () => {
    const entries = flattenStreams(streams);
    expect(entries.map((entry) => entry.message)).toEqual([
      "request completed",
      "payment declined by gateway: insufficient_funds",
      "incoming request",
    ]);
    expect(entries[1]).toEqual({
      timestamp: "2026-09-06T11:11:31.060Z",
      level: "warn",
      message: "payment declined by gateway: insufficient_funds",
      traceId: "ad14aad0456c157431dce7b3c79df366",
      spanId: "07424a29a5416943",
      fields: {
        reqId: "req-s",
        declineCode: "insufficient_funds",
        customerId: "00000000-0000-4000-8000-000000000001",
      },
    });
  });

  it("copes with a line that has no level or trace", () => {
    const [entry] = flattenStreams([
      { stream: { service_name: service }, values: [["1788693091000000000", "boot"]] },
    ]);
    expect(entry).toEqual({
      timestamp: "2026-09-06T11:11:31.000Z",
      level: undefined,
      message: "boot",
      traceId: undefined,
      spanId: undefined,
      fields: {},
    });
  });
});
