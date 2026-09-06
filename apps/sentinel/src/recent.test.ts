import { describe, expect, it } from "vitest";
import { createReportLedger, reportsEverything } from "./recent";

const checkout = "/customers/:customerId/checkout:http_500";

describe("createReportLedger", () => {
  it("holds a fingerprint it has just reported", () => {
    const ledger = createReportLedger(60_000);

    expect(ledger.held(checkout)).toBe(false);
    ledger.hold(checkout);
    expect(ledger.held(checkout)).toBe(true);
  });

  it("lets it go once the window it was measured over has rolled past", () => {
    let clock = 1_000;
    const ledger = createReportLedger(60_000, () => clock);
    ledger.hold(checkout);

    clock += 59_999;
    expect(ledger.held(checkout)).toBe(true);
    clock += 1;
    expect(ledger.held(checkout)).toBe(false);
  });

  it("holds each problem on its own, so one route failing does not silence another", () => {
    const ledger = createReportLedger(60_000);
    ledger.hold(checkout);

    expect(ledger.held("/products:http_500")).toBe(false);
  });
});

describe("reportsEverything", () => {
  it("holds nothing", () => {
    reportsEverything.hold(checkout);
    expect(reportsEverything.held(checkout)).toBe(false);
  });
});
