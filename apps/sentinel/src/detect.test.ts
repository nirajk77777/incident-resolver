import type { ErrorRate } from "@incident-resolver/mcp-observability";
import { describe, expect, it } from "vitest";
import { anomaliesIn, dominantErrorType, fingerprintOf } from "./detect";

const thresholds = { errorRatio: 0.2, windowSeconds: 60, minRequests: 5 };

const rate = (over: Partial<ErrorRate> & Pick<ErrorRate, "route">): ErrorRate => ({
  window: "60s",
  requests: 0,
  errors: 0,
  serverErrors: 0,
  errorRate: 0,
  serverErrorRate: 0,
  byStatusCode: {},
  ...over,
});

describe("dominantErrorType", () => {
  it("names the status code most of the failures came back as", () => {
    expect(dominantErrorType({ "200": 40, "500": 30, "402": 2 })).toBe("http_500");
  });

  it("ignores successes, so a mostly healthy route is still keyed on how it fails", () => {
    expect(dominantErrorType({ "200": 900, "503": 3 })).toBe("http_503");
  });

  it("says so when nothing failed", () => {
    expect(dominantErrorType({ "200": 10 })).toBe("http_error");
  });
});

describe("fingerprintOf", () => {
  it("keys the problem on the route and the kind of error, not on the Ticket", () => {
    expect(fingerprintOf("/customers/:customerId/checkout", "http_500")).toBe(
      "/customers/:customerId/checkout:http_500",
    );
  });
});

describe("anomaliesIn", () => {
  const failing = rate({
    route: "/customers/:customerId/checkout",
    requests: 100,
    errors: 97,
    serverErrors: 97,
    errorRate: 0.97,
    serverErrorRate: 0.97,
    byStatusCode: { "201": 3, "500": 97 },
  });

  it("reports a route over the ratio with enough requests behind it", () => {
    expect(anomaliesIn([failing], thresholds)).toEqual([
      {
        route: "/customers/:customerId/checkout",
        fingerprint: "/customers/:customerId/checkout:http_500",
        errorType: "http_500",
        window: "60s",
        requests: 100,
        serverErrors: 97,
        serverErrorRate: 0.97,
        byStatusCode: { "201": 3, "500": 97 },
      },
    ]);
  });

  it("holds back a route with too few requests to mean anything", () => {
    const quiet = { ...failing, requests: 4, errors: 4, serverErrors: 4 };
    expect(anomaliesIn([quiet], thresholds)).toEqual([]);
  });

  it("holds back a route at or under the ratio", () => {
    const borderline = { ...failing, serverErrorRate: 0.2 };
    expect(anomaliesIn([borderline], thresholds)).toEqual([]);
  });

  it("ignores customer-facing failures: a declined card is not an outage", () => {
    const declines = rate({
      route: "/customers/:customerId/checkout",
      requests: 50,
      errors: 45,
      serverErrors: 0,
      errorRate: 0.9,
      serverErrorRate: 0,
      byStatusCode: { "201": 5, "402": 45 },
    });
    expect(anomaliesIn([declines], thresholds)).toEqual([]);
  });

  it("puts the worst route first when several are failing", () => {
    const other = rate({
      route: "/products",
      requests: 20,
      errors: 10,
      serverErrors: 10,
      errorRate: 0.5,
      serverErrorRate: 0.5,
      byStatusCode: { "200": 10, "500": 10 },
    });
    expect(anomaliesIn([other, failing], thresholds).map((found) => found.route)).toEqual([
      "/customers/:customerId/checkout",
      "/products",
    ]);
  });
});
