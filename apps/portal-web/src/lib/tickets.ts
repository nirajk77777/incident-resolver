import type {
  EvidenceReference,
  IncidentCategory,
  Outcome,
  TicketEventType,
  TicketSource,
  TicketStatus,
  tickets,
} from "@incident-resolver/shared";

/**
 * The vocabulary of CONTEXT.md, and the small amount of reasoning the views do over it. The
 * types come from `@incident-resolver/shared`, which owns them: the imports are type-only, so
 * nothing of the database client they sit next to reaches the browser bundle.
 */
export type {
  EvidenceReference,
  IncidentCategory,
  Outcome,
  TicketEventType,
  TicketSource,
  TicketStatus,
};

/** A Ticket as the portal serves it: the row, with its times as ISO strings over JSON. */
export type Ticket = Omit<typeof tickets.$inferSelect, "createdAt" | "closedAt"> & {
  createdAt: string;
  closedAt: string | null;
};

/** One entry of a Ticket's Timeline, as an SSE frame carries it. */
export type TimelineEntry = {
  id: number;
  run: number;
  type: TicketEventType;
  payload: Record<string, unknown>;
  createdAt: string;
};

/** A run is over when the Ticket is closed; everything before that is still moving. */
export function isRunning(ticket: Pick<Ticket, "status">): boolean {
  return ticket.status !== "closed";
}

const statusLabels: Record<TicketStatus, string> = {
  new: "New",
  triaging: "Triaging",
  investigating: "Investigating",
  awaiting_approval: "Awaiting approval",
  acting: "Acting",
  closed: "Closed",
};

const outcomeLabels: Record<Outcome, string> = {
  answered: "Answered",
  data_fixed: "Data fixed",
  fix_proposed: "Fix proposed",
  escalated: "Escalated",
};

const categoryLabels: Record<IncidentCategory, string> = {
  question: "Question",
  user_error: "User error",
  data_issue: "Data issue",
  code_bug: "Code bug",
  infra: "Infra",
  unknown: "Unknown",
};

const sourceLabels: Record<TicketSource, string> = {
  customer: "Customer",
  tester: "Tester",
  sentinel: "Sentinel",
};

export const statusLabel = (status: TicketStatus) => statusLabels[status];
export const outcomeLabel = (outcome: Outcome) => outcomeLabels[outcome];
export const categoryLabel = (category: IncidentCategory) => categoryLabels[category];
export const sourceLabel = (source: TicketSource) => sourceLabels[source];

/** Confidence as the whole percent the list column shows. Nothing yet reads as an em dash. */
export function confidenceLabel(confidence: number | null): string {
  if (confidence === null) return "—";
  return `${Math.round(confidence * 100)}%`;
}

/** The last eight characters of the id: enough to tell two Tickets apart when talking. */
export function shortId(id: string): string {
  return id.replace(/-/g, "").slice(-8);
}

/**
 * Timeline entries in the order the portal wrote them, with anything already held dropped.
 * The SSE stream replays what a reloaded page missed and then goes live, so the same entry
 * can arrive twice; the sequence the portal assigned is what decides.
 */
export function mergeEntries(held: TimelineEntry[], arriving: TimelineEntry[]): TimelineEntry[] {
  const byId = new Map(held.map((entry) => [entry.id, entry]));
  for (const entry of arriving) byId.set(entry.id, entry);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}
