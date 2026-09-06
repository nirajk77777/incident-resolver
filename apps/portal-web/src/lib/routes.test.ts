import { describe, expect, it } from "vitest";
import { hrefFor, parseRoute } from "./routes";

const id = "50000000-0000-4000-8000-000000000101";

describe("parseRoute", () => {
  it("reads the queue, one Ticket, and the form that files one", () => {
    expect(parseRoute("/")).toEqual({ page: "tickets" });
    expect(parseRoute("/tickets")).toEqual({ page: "tickets" });
    expect(parseRoute("/tickets/new")).toEqual({ page: "new-ticket" });
    expect(parseRoute(`/tickets/${id}`)).toEqual({ page: "ticket", id });
  });

  it("falls back to the queue for anything else", () => {
    expect(parseRoute("/nowhere")).toEqual({ page: "tickets" });
    expect(parseRoute("")).toEqual({ page: "tickets" });
  });

  it("round trips a route through its href", () => {
    for (const route of [
      { page: "tickets" },
      { page: "new-ticket" },
      { page: "ticket", id },
    ] as const) {
      expect(parseRoute(hrefFor(route))).toEqual(route);
    }
  });
});
