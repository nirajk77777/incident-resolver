import { describe, expect, it } from "vitest";
import { ticketSchema } from "./ticket";

const base = {
  id: "50000000-0000-4000-8000-000000000001",
  source: "customer",
  reporterEmail: "ava.chen@example.com",
  title: "Product images stopped loading after the sale",
  body: "The catalog shows broken boxes where the pictures were.",
};

describe("ticketSchema", () => {
  it("accepts a customer Ticket with a reporter email", () => {
    expect(ticketSchema.parse(base)).toEqual(base);
  });

  it("accepts an optional ShopLite trace id", () => {
    const parsed = ticketSchema.parse({ ...base, traceId: "0af7651916cd43dd8448eb211c80319c" });
    expect(parsed.traceId).toBe("0af7651916cd43dd8448eb211c80319c");
  });

  it("requires a reporter email on customer Tickets", () => {
    const { reporterEmail: _dropped, ...noEmail } = base;
    const result = ticketSchema.safeParse(noEmail);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toContain("reporterEmail");
  });

  it("lets tester and sentinel Tickets omit the reporter email", () => {
    const { reporterEmail: _dropped, ...noEmail } = base;
    expect(ticketSchema.safeParse({ ...noEmail, source: "tester" }).success).toBe(true);
    expect(ticketSchema.safeParse({ ...noEmail, source: "sentinel" }).success).toBe(true);
  });

  it("rejects an unknown Source, a non-uuid id, and an empty body", () => {
    expect(ticketSchema.safeParse({ ...base, source: "email" }).success).toBe(false);
    expect(ticketSchema.safeParse({ ...base, id: "ticket-1" }).success).toBe(false);
    expect(ticketSchema.safeParse({ ...base, body: "" }).success).toBe(false);
  });
});
