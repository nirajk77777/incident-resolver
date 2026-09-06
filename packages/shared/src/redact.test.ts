import { describe, expect, it } from "vitest";
import { redact } from "./redact";

const reporter = "ava.chen@example.com";

describe("redact card numbers", () => {
  it.each([
    ["4242424242424242", "[redacted card]"],
    ["4000 0000 0000 0002", "[redacted card]"],
    ["4000-0000-0000-0002", "[redacted card]"],
    ["4222222222222", "[redacted card]"],
    ["6011111111111111117", "[redacted card]"],
    ["card 4242424242424242 declined", "card [redacted card] declined"],
  ])("masks %s entirely", (input, expected) => {
    expect(redact(input, {})).toBe(expected);
  });

  it("leaves shorter and longer digit runs alone", () => {
    expect(redact("123456789012", {})).toBe("123456789012");
    expect(redact("12345678901234567890", {})).toBe("12345678901234567890");
    expect(redact("last4 0002, amount 129900", {})).toBe("last4 0002, amount 129900");
  });

  it("keeps uuids, timestamps, trace ids, and gateway references intact", () => {
    const values = [
      "00000000-0000-4000-8000-000000000001",
      "2026-09-06T13:25:00.000Z",
      "4bf92f3577b34da6a3ce929d0e0e4736",
      "ch_0123456789abcdef01234567",
      "ref_1234567890123456",
    ];
    for (const value of values) expect(redact(value, {})).toBe(value);
  });
});

describe("redact emails", () => {
  it("masks every email when there is no reporter", () => {
    expect(redact("from liam.okafor@example.com", {})).toBe("from [redacted email]");
  });

  it("keeps the reporter's email, whatever its case, and masks the rest", () => {
    const text = "Ava.Chen@Example.com wrote to liam.okafor@example.com";
    expect(redact(text, { reporterEmail: reporter })).toBe(
      "Ava.Chen@Example.com wrote to [redacted email]",
    );
  });
});

describe("redact walks result structures", () => {
  it("masks inside nested objects and arrays and leaves other types alone", () => {
    const rows = [
      {
        id: "00000000-0000-4000-8000-000000000002",
        email: "liam.okafor@example.com",
        note: "paid with 4242 4242 4242 4242",
        amount: 1200,
        paid: true,
        ref: null,
        lines: [{ sku: "MUG-01", buyer: reporter }],
      },
    ];
    expect(redact(rows, { reporterEmail: reporter })).toEqual([
      {
        id: "00000000-0000-4000-8000-000000000002",
        email: "[redacted email]",
        note: "paid with [redacted card]",
        amount: 1200,
        paid: true,
        ref: null,
        lines: [{ sku: "MUG-01", buyer: reporter }],
      },
    ]);
  });

  it("masks a numeric value that is shaped like a card number", () => {
    expect(redact({ n: 4242424242424242, amount: 1200, ratio: 0.5 }, {})).toEqual({
      n: "[redacted card]",
      amount: 1200,
      ratio: 0.5,
    });
  });

  it("does not mutate its input", () => {
    const row = { email: "liam.okafor@example.com" };
    redact(row, {});
    expect(row.email).toBe("liam.okafor@example.com");
  });
});
