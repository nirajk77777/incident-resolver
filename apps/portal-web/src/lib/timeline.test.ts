import { describe, expect, it } from "vitest";
import type { TicketEventType, TimelineEntry } from "./tickets";
import { byRun, cardFor, elapsedLabel, openSubagents, PREVIEW_LIMIT, preview } from "./timeline";

let nextId = 1;

function entry(
  type: TicketEventType,
  payload: Record<string, unknown>,
  { run = 1, at = 0 }: { run?: number; at?: number } = {},
): TimelineEntry {
  return {
    id: nextId++,
    run,
    type,
    payload,
    createdAt: new Date(Date.UTC(2026, 0, 1, 12, 0, at)).toISOString(),
  };
}

describe("cardFor", () => {
  it("opens a subagent card on its start and closes it with what it answered", () => {
    expect(cardFor(entry("subagent_start", { name: "triage" }))).toEqual({
      kind: "subagent",
      heading: "triage",
      detail: "Started",
      pending: true,
    });
    expect(cardFor(entry("subagent_end", { name: "triage", summary: "A declined card" }))).toEqual({
      kind: "subagent",
      heading: "triage",
      detail: "A declined card",
      monoDetail: false,
    });
  });

  it("sets a subagent's structured answer as the machine text it is", () => {
    const card = cardFor(entry("subagent_end", { name: "triage", summary: '{"category":"x"}' }));

    expect(card.detail).toBe('{"category":"x"}');
    expect(card.monoDetail).toBe(true);
  });

  it("says a subagent finished when it summarised nothing", () => {
    expect(cardFor(entry("subagent_end", { name: "triage", summary: null })).detail).toBe(
      "Finished",
    );
  });

  it("leads a tool card with the query it ran, and keeps the rest in the fold", () => {
    const call = entry("tool_call", { name: "run_readonly_sql", args: { sql: "SELECT 1" } });
    const card = cardFor(call);

    expect(card.kind).toBe("tool");
    expect(card.heading).toBe("run_readonly_sql");
    expect(card.detail).toBe("SELECT 1");
    expect(card.monoDetail).toBe(true);
    expect(card.payload).toBe(call.payload);
  });

  it("reads a Proposal as what it is waiting for", () => {
    expect(cardFor(entry("interrupt", { action: "propose_data_fix", proposal: {} }))).toMatchObject(
      { kind: "interrupt", heading: "propose_data_fix", detail: "Waiting for a Decision" },
    );
  });

  it("leads the Verdict card with the root cause", () => {
    expect(
      cardFor(entry("verdict", { outcome: "answered", rootCause: "The card was declined" })).detail,
    ).toBe("The card was declined");
  });

  it("names an entry whose payload is missing rather than showing nothing", () => {
    expect(cardFor(entry("tool_call", {})).heading).toBe("unknown");
    expect(cardFor(entry("tool_call", {})).detail).toBeUndefined();
    expect(cardFor(entry("message", {})).detail).toBeUndefined();
  });
});

describe("preview", () => {
  it("is the value itself when a call has one field", () => {
    expect(preview({ sql: "SELECT 1" })).toBe("SELECT 1");
    expect(preview("no lines matched")).toBe("no lines matched");
  });

  it("is the shape when there is more than one field", () => {
    expect(preview({ rowCount: 1, rows: [] })).toBe('{"rowCount":1,"rows":[]}');
  });

  it("is one line, cut to what a card can hold", () => {
    expect(preview({ sql: "SELECT\n  1" })).toBe("SELECT 1");
    const long = preview({ sql: "x".repeat(PREVIEW_LIMIT + 20) });
    expect(long).toHaveLength(PREVIEW_LIMIT + 1);
    expect(long?.endsWith("…")).toBe(true);
  });

  it("says nothing about a call that carried nothing", () => {
    expect(preview(undefined)).toBeUndefined();
    expect(preview(null)).toBeUndefined();
    expect(preview({ sql: "   " })).toBeUndefined();
  });
});

describe("elapsedLabel", () => {
  it("counts from the first entry of that entry's own run", () => {
    const entries = [
      entry("subagent_start", { name: "triage" }, { at: 0 }),
      entry("message", { text: "working" }, { at: 4 }),
      entry("subagent_start", { name: "triage" }, { run: 2, at: 40 }),
      entry("message", { text: "again" }, { run: 2, at: 105 }),
    ];

    expect(entries.map((one) => elapsedLabel(one, entries))).toEqual([
      "+0:00",
      "+0:04",
      "+0:00",
      "+1:05",
    ]);
  });

  it("says nothing when a timestamp cannot be read", () => {
    const broken = { ...entry("message", {}), createdAt: "not a time" };
    expect(elapsedLabel(broken, [broken])).toBe("");
  });
});

describe("byRun", () => {
  it("groups a re-run after the run before it", () => {
    const entries = [
      entry("message", { text: "one" }, { run: 2 }),
      entry("message", { text: "two" }, { run: 1 }),
    ];

    expect(byRun(entries).map((group) => group.run)).toEqual([1, 2]);
  });
});

describe("openSubagents", () => {
  it("holds a subagent open until its end arrives", () => {
    const started = entry("subagent_start", { name: "log-investigator" });
    const other = entry("subagent_start", { name: "data-investigator" });
    const ended = entry("subagent_end", { name: "data-investigator" });

    expect(openSubagents([started, other, ended])).toEqual(new Set([started.id]));
    expect(
      openSubagents([started, other, ended, entry("subagent_end", { name: "log-investigator" })]),
    ).toEqual(new Set());
  });
});
