import type {
  Approval,
  ManualResolutionInput,
  ReviewerDecision,
  Ticket,
  TimelineEntry,
} from "./tickets";

/**
 * Everything the portal reads. The API is served under `/api` by the dev server's proxy, so
 * requests are same-origin and the browser needs no CORS headers to be right.
 */
const API = "/api";

/** What the portal serves about itself: which Resolver runs, and where its traces live. */
export type PortalConfig = {
  resolver: string;
  grafanaUrl: string;
  langfuseBaseUrl: string;
};

/** A tester's report, as the form files it. */
export type NewTicket = {
  source: "tester";
  title: string;
  body: string;
  traceId?: string;
};

async function read<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, init);
  if (!response.ok) {
    const problem = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(problem?.message ?? `${response.status} from ${path}`);
  }
  return (await response.json()) as T;
}

export const fetchConfig = () => read<PortalConfig>("/config");

export const fetchTickets = () =>
  read<{ tickets: Ticket[] }>("/tickets").then((body) => body.tickets);

export const fetchTicket = (id: string) => read<Ticket>(`/tickets/${encodeURIComponent(id)}`);

export const fileTicket = (ticket: NewTicket) =>
  read<Ticket>("/tickets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(ticket),
  });

/** Every Proposal this Ticket has raised, newest first, and what became of each. */
export const fetchApprovals = (id: string) =>
  read<{ approvals: Approval[] }>(`/tickets/${encodeURIComponent(id)}/approvals`).then(
    (body) => body.approvals,
  );

/**
 * The Reviewer's answer to the Proposal a Ticket is waiting on. The portal records it and
 * carries the run on in the background, so what happens next arrives on the timeline.
 */
export const decide = (id: string, decision: ReviewerDecision) =>
  read<{ approval: Approval }>(`/tickets/${encodeURIComponent(id)}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(decision),
  }).then((body) => body.approval);

/**
 * How a Reviewer finishes an escalated Ticket. The portal closes it on what they wrote and
 * writes the Incident, so the next similar Ticket finds what a person worked out here.
 */
export const resolveTicket = (id: string, resolution: ManualResolutionInput) =>
  read<Ticket>(`/tickets/${encodeURIComponent(id)}/resolution`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(resolution),
  });

/**
 * Runs a closed Ticket again on a fresh thread. The Ticket comes back reopened; the new run's
 * entries arrive on the timeline under the next run number, with the earlier runs left where
 * they are.
 */
export const rerunTicket = (id: string) =>
  read<Ticket>(`/tickets/${encodeURIComponent(id)}/rerun`, { method: "POST" });

/**
 * The live timeline. `lastEventId` is the sequence the page already holds, so a reconnect
 * replays only what it missed; `EventSource` cannot set headers, which is why the portal
 * also reads it from the query.
 */
export function timelineUrl(ticketId: string, lastEventId: number): string {
  const path = `${API}/tickets/${encodeURIComponent(ticketId)}/events`;
  return lastEventId > 0 ? `${path}?lastEventId=${lastEventId}` : path;
}

/** One SSE frame, which carries a timeline entry. */
export function parseTimelineFrame(data: string): TimelineEntry | undefined {
  try {
    return JSON.parse(data) as TimelineEntry;
  } catch {
    return undefined;
  }
}
