import type { Verdict } from "@incident-resolver/shared";
import { describe, expect, it } from "vitest";
import type { TimelineResolverEvent } from "./resolver";
import { nextStatus } from "./status";

const verdict = {
  outcome: "answered",
  category: "user_error",
  confidence: 0.9,
  rootCause: "The card was declined",
  evidence: [],
  reply: "Try another card",
} satisfies Verdict;

describe("nextStatus", () => {
  it("moves a new Ticket to triaging when Triage starts", () => {
    expect(nextStatus("new", { type: "subagent_start", name: "triage" })).toBe("triaging");
  });

  it("moves to investigating when any other subagent starts", () => {
    expect(nextStatus("triaging", { type: "subagent_start", name: "data-investigator" })).toBe(
      "investigating",
    );
  });

  it("stays where it is for events that are not lifecycle moves", () => {
    const passive: TimelineResolverEvent[] = [
      { type: "tool_call", name: "run_readonly_sql", args: { sql: "SELECT 1" } },
      { type: "tool_result", name: "run_readonly_sql", result: { rows: [] } },
      { type: "message", text: "Checking the cart totals" },
      { type: "subagent_end", name: "triage", summary: "A declined card" },
    ];
    for (const event of passive) {
      expect(nextStatus("investigating", event)).toBe("investigating");
    }
  });

  it("moves to awaiting approval on an interrupt", () => {
    expect(
      nextStatus("investigating", {
        type: "interrupt",
        action: "propose_data_fix",
        proposal: { kind: "data_fix" },
      }),
    ).toBe("awaiting_approval");
  });

  it("moves to acting once the run continues past an approval", () => {
    expect(nextStatus("awaiting_approval", { type: "message", text: "Applying the fix" })).toBe(
      "acting",
    );
    expect(nextStatus("acting", { type: "subagent_start", name: "data-investigator" })).toBe(
      "acting",
    );
  });

  it("closes on the Verdict, from wherever the run had got to", () => {
    expect(nextStatus("new", { type: "verdict", verdict })).toBe("closed");
    expect(nextStatus("awaiting_approval", { type: "verdict", verdict })).toBe("closed");
  });
});
