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
  /** The Reply the Ticket ends with, on the card that carries it. */
  reply?: string;
  /** The raw entry, for the fold. Absent when the heading and detail are the whole entry. */
  payload?: Record<string, unknown>;
  /** A subagent that has started and not yet ended: its card is still open. */
  pending?: boolean;
  /** Somewhere the card points out to: the pull request an internal note carries. */
  link?: string;
  /** The tool did not answer the call. The detail is the reason, and it says which. */
  failed?: boolean;
};

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const name = (payload: Record<string, unknown>) => text(payload.name) ?? "unknown";

/** How much of a tool's arguments, or of a subagent's answer, a card shows before the fold. */
export const PREVIEW_LIMIT = 140;

/** One line of something longer, cut to what a card can hold. */
const cut = (value: string) => {
  const line = value.replace(/\s+/g, " ").trim();
  if (line.length === 0) return undefined;
  return line.length <= PREVIEW_LIMIT ? line : `${line.slice(0, PREVIEW_LIMIT)}…`;
};

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
        // A subagent's whole answer is often several hundred characters of structured output,
        // which is the longest thing on a run: the card leads with a line of it and folds
        // the rest away like every other payload.
        detail: summary === undefined ? "Finished" : cut(summary),
        // A subagent with structured output answers in JSON: it is machine text, and set as it.
        monoDetail: summary !== undefined && /^[{[]/.test(summary),
        ...(summary === undefined ? {} : { payload }),
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
        // The one tool result a Reviewer must not read as an answer. The tenant guard turning
        // away an unscoped query lands here, and so does a tool that simply broke.
        ...(payload.failed === true ? { failed: true } : {}),
      };
    case "message": {
      // An internal note the portal wrote itself, rather than something the Resolver said.
      // The pull request link is the one the Reply is never allowed to carry, so this card
      // is where a Reviewer follows it from.
      const link = text(payload.url);
      return {
        kind: "message",
        heading: link ? "Internal note" : "Resolver",
        detail: text(payload.text),
        ...(link ? { link } : {}),
      };
    }
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
      // The Verdict is where the Ticket ends, so the Reply it ends with is on the card and
      // not only in the fold: it is the one thing on a Timeline written for a person to read.
      return {
        kind: "verdict",
        heading: "Verdict",
        detail: text(payload.rootCause),
        reply: text(payload.reply),
        payload,
      };
    case "status":
      return { kind: "status", heading: text(payload.status) ?? "moved" };
  }
}

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
  // Starts of one name are stacked rather than replaced, so a subagent the Resolver ran twice
  // is closed once per end and the earlier card is not silently closed by the later one.
  const openBy = new Map<string, number[]>();
  for (const entry of entries) {
    const subagent = name(entry.payload);
    const open = openBy.get(subagent) ?? [];
    if (entry.type === "subagent_start") openBy.set(subagent, [...open, entry.id]);
    if (entry.type === "subagent_end") openBy.set(subagent, open.slice(1));
  }
  return new Set([...openBy.values()].flat());
}
