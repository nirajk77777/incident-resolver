import { describe, expect, it } from "vitest";
import { durationSchema, isoFromNanos, parseDuration } from "./time";

describe("parseDuration", () => {
  it.each([
    ["30s", 30_000],
    ["15m", 900_000],
    ["2h", 7_200_000],
    ["1d", 86_400_000],
    ["500ms", 500],
  ])("reads %s as %i ms", (input, expected) => {
    expect(parseDuration(input)).toBe(expected);
  });

  it("rejects anything that is not a Prometheus-style duration", () => {
    for (const bad of ["", "15", "m", "1.5h", "15 m", "-1m", "1w2d", "1y"]) {
      expect(() => parseDuration(bad), bad).toThrow(/duration/);
    }
  });
});

describe("durationSchema", () => {
  it("accepts the same strings and keeps them as strings for the backing query", () => {
    expect(durationSchema.parse("5m")).toBe("5m");
    expect(durationSchema.safeParse("five minutes").success).toBe(false);
  });
});

describe("isoFromNanos", () => {
  it("converts a nanosecond epoch string to an ISO timestamp at millisecond precision", () => {
    expect(isoFromNanos("1788693091060180167")).toBe("2026-09-06T11:11:31.060Z");
  });
});
