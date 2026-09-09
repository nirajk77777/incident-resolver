import type { ResetReport } from "@incident-resolver/shared";
import { describe, expect, it } from "vitest";
import { demoProblem, isDemoShortcut, resetFinished, trafficStarted } from "./demo";

const chord = (over: Partial<KeyboardEvent> = {}) =>
  ({
    ctrlKey: true,
    altKey: true,
    metaKey: false,
    shiftKey: false,
    key: "d",
    code: "KeyD",
    ...over,
  }) as KeyboardEvent;

describe("isDemoShortcut", () => {
  it("is Ctrl and Alt and D, in either case", () => {
    expect(isDemoShortcut(chord())).toBe(true);
    expect(isDemoShortcut(chord({ key: "D" }))).toBe(true);
  });

  it("is Control and Option and D on a Mac, where Option turns the character into ∂", () => {
    expect(isDemoShortcut(chord({ key: "∂" }))).toBe(true);
  });

  it("is not any near miss, so ordinary typing never opens the panel", () => {
    expect(isDemoShortcut(chord({ ctrlKey: false }))).toBe(false);
    expect(isDemoShortcut(chord({ altKey: false }))).toBe(false);
    expect(isDemoShortcut(chord({ shiftKey: true }))).toBe(false);
    expect(isDemoShortcut(chord({ metaKey: true }))).toBe(false);
    expect(isDemoShortcut(chord({ key: "f", code: "KeyF" }))).toBe(false);
    expect(isDemoShortcut(chord({ key: "ƒ", code: "KeyF" }))).toBe(false);
  });
});

describe("trafficStarted", () => {
  it("says how much traffic is coming and what will happen next", () => {
    const outcome = trafficStarted({
      customerId: "00000000-0000-4000-8000-000000000005",
      durationMs: 30_000,
      intervalMs: 250,
      requests: 120,
    });

    expect(outcome.tone).toBe("done");
    expect(outcome.headline).toBe("120 empty-cart checkouts over 30s");
    expect(outcome.lines[0]).toContain("every 250ms");
    expect(outcome.lines[1]).toContain("Sentinel");
  });
});

describe("resetFinished", () => {
  const done: ResetReport = {
    ok: true,
    steps: [
      { step: "ShopLite data", done: true, detail: "reseeded" },
      { step: "Workspaces", done: true, detail: "every clone removed" },
    ],
  };

  it("lists what it did when everything finished", () => {
    const outcome = resetFinished(done);

    expect(outcome.tone).toBe("done");
    expect(outcome.headline).toBe("Everything is back where a rehearsal starts");
    expect(outcome.lines).toEqual(["shoplite data: reseeded", "workspaces: every clone removed"]);
  });

  it("counts what did not, and marks the step that failed", () => {
    const outcome = resetFinished({
      ok: false,
      steps: [
        { step: "ShopLite data", done: false, detail: "ECONNREFUSED" },
        ...done.steps.slice(1),
      ],
    });

    expect(outcome.tone).toBe("problem");
    expect(outcome.headline).toBe("1 of 2 steps did not finish");
    expect(outcome.lines[0]).toBe("could not shoplite data: ECONNREFUSED");
  });
});

describe("demoProblem", () => {
  it("shows what the portal said it could not do", () => {
    expect(demoProblem(new Error("2 Tickets are still running"))).toEqual({
      tone: "problem",
      headline: "2 Tickets are still running",
      lines: [],
    });
  });
});
