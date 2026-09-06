import { describe, expect, it } from "vitest";
import type { Anomaly } from "./detect";
import type { Evidence } from "./evidence";
import { createTicketWriter, plainTicketText, sentinelBrief } from "./ticket-text";

const anomaly: Anomaly = {
  route: "/customers/:customerId/checkout",
  fingerprint: "/customers/:customerId/checkout:http_500",
  errorType: "http_500",
  window: "60s",
  requests: 100,
  serverErrors: 97,
  serverErrorRate: 0.97,
  byStatusCode: { "201": 3, "500": 97 },
};

const evidence: Evidence = {
  traceIds: ["a".repeat(32), "b".repeat(32)],
  messages: [
    {
      level: "error",
      message: "Reduce of empty array with no initial value",
      count: 97,
      traceIds: ["a".repeat(32)],
    },
  ],
};

describe("sentinelBrief", () => {
  it("states the route, the ratio, the codes and the messages, and nothing it did not measure", () => {
    const brief = sentinelBrief(anomaly, evidence);

    expect(brief).toContain("/customers/:customerId/checkout");
    expect(brief).toContain("97%");
    expect(brief).toContain("100 requests");
    expect(brief).toContain("500: 97");
    expect(brief).toContain("Reduce of empty array with no initial value");
  });
});

describe("plainTicketText", () => {
  it("names the route and how badly it is failing", () => {
    const text = plainTicketText(anomaly, evidence);

    expect(text.title).toBe("97% of /customers/:customerId/checkout requests are failing");
    expect(text.body).toContain("100 requests");
    expect(text.body).toContain(`Trace ids: ${"a".repeat(32)}, ${"b".repeat(32)}`);
  });
});

describe("createTicketWriter", () => {
  it("uses the model's wording and attaches the trace ids itself", async () => {
    const write = createTicketWriter({
      compose: async (brief) => ({
        title: "Checkout is down",
        body: `Everyone is failing. ${brief.length} characters of evidence.`,
      }),
    });

    const text = await write(anomaly, evidence);

    expect(text.title).toBe("Checkout is down");
    expect(text.body).toContain("Everyone is failing.");
    // The ids are facts, so they are attached rather than left to the model to repeat.
    expect(text.body).toContain(`Trace ids: ${"a".repeat(32)}, ${"b".repeat(32)}`);
  });

  it("falls back to the plain wording when there is no model", async () => {
    const write = createTicketWriter({});

    expect((await write(anomaly, evidence)).title).toBe(
      "97% of /customers/:customerId/checkout requests are failing",
    );
  });

  it("falls back, and says why, when the model will not answer", async () => {
    const reasons: string[] = [];
    const write = createTicketWriter({
      compose: async () => {
        throw new Error("insufficient_quota");
      },
      onFallback: (reason) => reasons.push(reason),
    });

    const text = await write(anomaly, evidence);

    expect(text.title).toBe("97% of /customers/:customerId/checkout requests are failing");
    expect(reasons).toEqual(["insufficient_quota"]);
  });

  it("falls back when the model answers with nothing usable", async () => {
    const write = createTicketWriter({ compose: async () => ({ title: "  ", body: "" }) });

    expect((await write(anomaly, evidence)).title).toBe(
      "97% of /customers/:customerId/checkout requests are failing",
    );
  });

  it("leaves the trace id line off when Loki had nothing to give", async () => {
    const write = createTicketWriter({});
    const text = await write(anomaly, { traceIds: [], messages: [] });

    expect(text.body).not.toContain("Trace ids");
  });
});
