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
    const end = entry("subagent_end", { name: "triage", summary: "A declined card" });
    expect(cardFor(end)).toEqual({
      kind: "subagent",
      heading: "triage",
      detail: "A declined card",
      monoDetail: false,
      payload: end.payload,
    });
  });

  it("sets a subagent's structured answer as the machine text it is, and folds it away", () => {
    const end = entry("subagent_end", { name: "triage", summary: '{"category":"x"}' });
    const card = cardFor(end);

    expect(card.detail).toBe('{"category":"x"}');
    expect(card.monoDetail).toBe(true);
    expect(card.payload).toBe(end.payload);
  });

  it("cuts a long subagent answer down to a line, leaving the rest in the fold", () => {
    const summary = "y".repeat(PREVIEW_LIMIT + 40);
    const card = cardFor(entry("subagent_end", { name: "log-investigator", summary }));

    expect(card.detail).toHaveLength(PREVIEW_LIMIT + 1);
    expect(card.payload?.summary).toBe(summary);
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

  it("marks a tool call that did not answer, and leads the card with the reason", () => {
    const refused = entry("tool_result", {
      name: "run_readonly_sql",
      result: "Unfiltered here: orders.",
      failed: true,
    });
    const card = cardFor(refused);

    expect(card.kind).toBe("tool");
    expect(card.failed).toBe(true);
    expect(card.detail).toBe("Unfiltered here: orders.");
  });

  it("leaves a tool result that was answered unmarked", () => {
    const answered = entry("tool_result", {
      name: "run_readonly_sql",
      result: { rowCount: 1 },
      failed: false,
    });

    expect(cardFor(answered).failed).toBeUndefined();
  });

  it("reads a Proposal as what it is waiting for", () => {
    expect(cardFor(entry("interrupt", { action: "propose_data_fix", proposal: {} }))).toMatchObject(
      { kind: "interrupt", heading: "propose_data_fix", detail: "Waiting for a Decision" },
    );
  });

  it("leads the Verdict card with the root cause, and carries the Reply on it", () => {
    const card = cardFor(
      entry("verdict", {
        outcome: "answered",
        rootCause: "The card was declined",
        reply: "Your bank declined the payment. Please try another card.",
      }),
    );

    expect(card.detail).toBe("The card was declined");
    expect(card.reply).toBe("Your bank declined the payment. Please try another card.");
  });

  it("names an entry whose payload is missing rather than showing nothing", () => {
    expect(cardFor(entry("tool_call", {})).heading).toBe("unknown");
    expect(cardFor(entry("tool_call", {})).detail).toBeUndefined();
    expect(cardFor(entry("message", {})).detail).toBeUndefined();
  });

  it("draws an internal note carrying a pull request as its own card, with the link", () => {
    const card = cardFor(
      entry("message", {
        text: "Pull request opened on fix/ticket-1: https://github.com/n/s/pull/9",
        reason: "pull_request",
        url: "https://github.com/n/s/pull/9",
      }),
    );

    expect(card.heading).toBe("Internal note");
    expect(card.link).toBe("https://github.com/n/s/pull/9");
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

  it("closes one card per end when the same subagent ran twice", () => {
    const first = entry("subagent_start", { name: "data-investigator" });
    const second = entry("subagent_start", { name: "data-investigator" });
    const ended = entry("subagent_end", { name: "data-investigator" });

    expect(openSubagents([first, second, ended])).toEqual(new Set([second.id]));
  });
});
