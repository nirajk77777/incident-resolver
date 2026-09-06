import type { TimelineEntry } from "./timeline";

/** A comment frame. Sent on an idle stream so proxies and browsers keep the connection. */
export const SSE_KEEP_ALIVE = ": keep-alive\n\n";

export const SSE_KEEP_ALIVE_MS = 15_000;

export const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  // Nginx and friends buffer text/event-stream by default, which stalls the live timeline.
  "x-accel-buffering": "no",
} as const;

/**
 * One timeline entry on the wire. Frames are unnamed, so an `EventSource`'s `onmessage`
 * receives the whole timeline and reads the kind of entry off `type` in the data; naming
 * them per type would silently deliver nothing to a client that had not subscribed to all
 * of them. The frame's id is the entry's sequence, which is what a client sends back as
 * `Last-Event-ID` after a reload, so catch-up needs no other state.
 */
export function formatSseFrame(entry: TimelineEntry): string {
  const data = JSON.stringify({ ...entry, createdAt: entry.createdAt.toISOString() });
  return `id: ${entry.id}\ndata: ${data}\n\n`;
}

/**
 * Where a client wants the timeline to resume: the `Last-Event-ID` header an EventSource
 * sends on reconnect, or the `lastEventId` query for a client that cannot set headers.
 * Anything unreadable means "from the beginning", which is always safe to replay.
 */
export function lastEventIdOf(header: string | string[] | undefined, query?: string): number {
  const raw = (Array.isArray(header) ? header[0] : header) ?? query;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}
