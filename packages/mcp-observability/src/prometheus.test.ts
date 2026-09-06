import { describe, expect, it } from "vitest";
import { escapeLabelValue } from "./escape";
import { errorRateFrom, errorRateQuery, type PromVector } from "./prometheus";

const route = "/customers/:customerId/checkout";

describe("errorRateQuery", () => {
  it("counts requests by status code as the counter's growth since the start of the window", () => {
    const counter =
      'http_server_request_duration_seconds_count{job="shoplite-api", http_route="/customers/:customerId/checkout"}';
    expect(errorRateQuery({ job: "shoplite-api", route, window: "60s" })).toBe(
      `sum by (http_response_status_code) (clamp_min((${counter} - (${counter} offset 60s)) or ${counter}, 0))`,
    );
  });

  it("escapes quotes and backslashes in the route", () => {
    expect(escapeLabelValue('a"b\\c')).toBe('a\\"b\\\\c');
  });
});

describe("errorRateFrom", () => {
  const vector: PromVector = [
    { metric: { http_response_status_code: "201" }, value: [1, "7"] },
    { metric: { http_response_status_code: "402" }, value: [1, "2"] },
    { metric: { http_response_status_code: "500" }, value: [1, "1"] },
  ];

  it("reads the counts and splits errors into client and server", () => {
    expect(errorRateFrom({ route, window: "5m" }, vector)).toEqual({
      route,
      window: "5m",
      requests: 10,
      errors: 3,
      serverErrors: 1,
      errorRate: 0.3,
      serverErrorRate: 0.1,
      byStatusCode: { "201": 7, "402": 2, "500": 1 },
    });
  });

  it("reports zero rates, not NaN, when the route saw no traffic", () => {
    expect(errorRateFrom({ route, window: "1m" }, [])).toEqual({
      route,
      window: "1m",
      requests: 0,
      errors: 0,
      serverErrors: 0,
      errorRate: 0,
      serverErrorRate: 0,
      byStatusCode: {},
    });
  });

  it("compares status codes as numbers, not strings", () => {
    const rate = errorRateFrom({ route, window: "1m" }, [
      { metric: { http_response_status_code: "99" }, value: [1, "1"] },
      { metric: { http_response_status_code: "1000" }, value: [1, "1"] },
    ]);
    expect(rate).toMatchObject({ requests: 2, errors: 1, serverErrors: 1 });
  });

  it("drops a sample with no status code label rather than miscounting it", () => {
    const rate = errorRateFrom({ route, window: "1m" }, [{ metric: {}, value: [1, "3"] }]);
    expect(rate.requests).toBe(0);
  });
});
