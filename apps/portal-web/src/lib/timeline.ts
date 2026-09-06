import type { TimelineEntry } from "./tickets";

/**
 * How a timeline entry reads on the Ticket page. Every entry becomes one card: a kind that
 * decides how it is drawn, a heading, a line of prose under it when there is one, and the
 * payload, which stays collapsed until the Reviewer asks for it.
 */
export type TimelineCard = {
  kind: "subagent" | "tool" | "message" | "interrupt" | "decision" | "verdict" | "status";
  /** What the entry is: the subagent, the tool, or the move the portal made. */
  heading: string;
  /** The entry in one line, when it says something a Reviewer can read without unfolding it. */
  detail?: string;
  /** The detail is something the machine wrote — a query, a result — so it is set as one. */
  monoDetail?: boolean;
  /** The raw entry, for the fold. Absent when the heading and detail are the whole entry. */
  payload?: Record<string, unknown>;
  /** A subagent that has started and not yet ended: its card is still open. */
  pending?: boolean;
};

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const name = (payload: Record<string, unknown>) => text(payload.name) ?? "unknown";

/** What one timeline entry becomes on the page. */
export function cardFor(entry: TimelineEntry): TimelineCard {
  const { payload } = entry;
  switch (entry.type) {
    case "subagent_start":
      return { kind: "subagent", heading: name(payload), detail: "Started", pending: true };
    case "subagent_end": {
      const summary = text(payload.summary);
      return {
        kind: "subagent",
        heading: name(payload),
        detail: summary ?? "Finished",
        // A subagent with structured output answers in JSON: it is machine text, and set as it.
        monoDetail: summary !== undefined && /^[{[]/.test(summary),
      };
    }
    case "tool_call":
      return {
        kind: "tool",
        heading: name(payload),
        detail: preview(payload.args),
        monoDetail: true,
        payload,
      };
    case "tool_result":
      return {
        kind: "tool",
        heading: name(payload),
        detail: preview(payload.result),
        monoDetail: true,
        payload,
      };
    case "message":
      return { kind: "message", heading: "Resolver", detail: text(payload.text) };
    case "interrupt":
      return {
        kind: "interrupt",
        heading: text(payload.action) ?? "Proposal",
        detail: "Waiting for a Decision",
        payload,
      };
    case "decision":
      return {
        kind: "decision",
        heading: text(payload.decision) ?? "Decision",
        detail: text(payload.action),
        payload,
      };
    case "verdict":
      return {
        kind: "verdict",
        heading: "Verdict",
        detail: text(payload.rootCause),
        payload,
      };
    case "status":
      return { kind: "status", heading: text(payload.status) ?? "moved" };
  }
}

/** How much of a tool's arguments or result a card shows before the fold is the way to read it. */
export const PREVIEW_LIMIT = 140;

/**
 * The one line a tool card leads with: the query that was run, or what came back. A single
 * field is shown as its value, since the field name is already the tool's; anything larger
 * is shown as the shape it is, and the fold has the rest.
 */
export function preview(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object") return cut(String(value));

  const entries = Object.entries(value as Record<string, unknown>);
  const only = entries.length === 1 ? entries[0]?.[1] : undefined;
  if (typeof only === "string") return cut(only);

  try {
    return cut(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

const cut = (text: string) => {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length === 0) return undefined;
  return line.length <= PREVIEW_LIMIT ? line : `${line.slice(0, PREVIEW_LIMIT)}…`;
};

/**
 * Where an entry sits in its run, as `+m:ss` from the run's first entry. Elapsed time rather
 * than a wall clock: what a Reviewer watching a run wants to know is how long it has taken.
 */
export function elapsedLabel(entry: TimelineEntry, entries: TimelineEntry[]): string {
  const first = entries.find((candidate) => candidate.run === entry.run);
  const from = first ? Date.parse(first.createdAt) : Number.NaN;
  const at = Date.parse(entry.createdAt);
  if (Number.isNaN(from) || Number.isNaN(at)) return "";
  const seconds = Math.max(0, Math.round((at - from) / 1000));
  return `+${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** A run's entries, oldest first, newest run last: how the page reads a re-run. */
export function byRun(entries: TimelineEntry[]): Array<{ run: number; entries: TimelineEntry[] }> {
  const runs = new Map<number, TimelineEntry[]>();
  for (const entry of entries) {
    const held = runs.get(entry.run) ?? [];
    held.push(entry);
    runs.set(entry.run, held);
  }
  return [...runs.entries()]
    .sort(([a], [b]) => a - b)
    .map(([run, ofRun]) => ({ run, entries: ofRun }));
}

/**
 * The subagents that have started and not yet ended. A start opens a card and the matching
 * end closes it, so a run interrupted mid-Investigator leaves its card open, which is the
 * truth: nothing came back.
 */
export function openSubagents(entries: TimelineEntry[]): Set<number> {
  const openBy = new Map<string, number>();
  for (const entry of entries) {
    if (entry.type === "subagent_start") openBy.set(name(entry.payload), entry.id);
    if (entry.type === "subagent_end") openBy.delete(name(entry.payload));
  }
  return new Set(openBy.values());
}
