import { describe, expect, it } from "vitest";
import { confidenceLabel, isRunning, mergeEntries, shortId, type TimelineEntry } from "./tickets";

const entry = (id: number, run = 1): TimelineEntry => ({
  id,
  run,
  type: "message",
  payload: { text: `entry ${id}` },
  createdAt: new Date(id * 1000).toISOString(),
});

describe("isRunning", () => {
  it("is true until the Ticket closes", () => {
    expect(isRunning({ status: "new" })).toBe(true);
    expect(isRunning({ status: "awaiting_approval" })).toBe(true);
    expect(isRunning({ status: "closed" })).toBe(false);
  });
});

describe("confidenceLabel", () => {
  it("is a whole percent, and an em dash before the Verdict", () => {
    expect(confidenceLabel(0.86)).toBe("86%");
    expect(confidenceLabel(0)).toBe("0%");
    expect(confidenceLabel(null)).toBe("—");
  });
});

describe("shortId", () => {
  it("is the last eight characters, without the dashes", () => {
    expect(shortId("50000000-0000-4000-8000-0000000001af")).toBe("0000001af".slice(-8));
  });
});

describe("mergeEntries", () => {
  it("keeps entries in the order the portal wrote them", () => {
    expect(mergeEntries([entry(3)], [entry(1), entry(2)]).map((held) => held.id)).toEqual([
      1, 2, 3,
    ]);
  });

  it("holds one copy of an entry the stream replayed", () => {
    const held = mergeEntries([entry(1), entry(2)], [entry(2), entry(3)]);
    expect(held.map((one) => one.id)).toEqual([1, 2, 3]);
  });

  it("leaves what is already held alone when nothing arrives", () => {
    expect(mergeEntries([entry(1)], [])).toEqual([entry(1)]);
  });
});
