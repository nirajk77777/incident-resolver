import { describe, expect, it } from "vitest";
import { clockTime, relativeTime } from "./time";

const now = new Date("2026-09-06T12:00:00.000Z");
const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000).toISOString();

describe("relativeTime", () => {
  it("reads as how long ago, at the coarsest unit that still says something", () => {
    expect(relativeTime(ago(5), now)).toBe("just now");
    expect(relativeTime(ago(240), now)).toBe("4m ago");
    expect(relativeTime(ago(3 * 3600), now)).toBe("3h ago");
    expect(relativeTime(ago(50 * 3600), now)).toBe("2d ago");
  });

  it("says nothing about a time it cannot read", () => {
    expect(relativeTime("whenever", now)).toBe("");
    expect(clockTime("whenever")).toBe("");
  });
});
