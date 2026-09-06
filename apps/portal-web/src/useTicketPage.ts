import { useEffect, useState } from "react";
import { fetchTicket, parseTimelineFrame, timelineUrl } from "./lib/api";
import { mergeEntries, type Ticket, type TimelineEntry } from "./lib/tickets";

export type TicketPage = {
  ticket: Ticket | null;
  entries: TimelineEntry[];
  error: string | null;
};

/**
 * One Ticket, live. The timeline arrives over SSE, which replays whatever the page missed
 * before it goes live, so a reload during a run loses nothing and a dropped connection is
 * the browser's problem: `EventSource` reconnects on its own with the last id it saw.
 *
 * The Ticket row is re-read whenever the lifecycle moves, since that is also when the run's
 * Outcome, Reply and Langfuse trace land on it.
 */
export function useTicketPage(id: string): TicketPage {
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let watching = true;
    setTicket(null);
    setEntries([]);
    setError(null);

    const readTicket = async () => {
      try {
        const found = await fetchTicket(id);
        if (watching) setTicket(found);
      } catch (problem) {
        if (watching) setError(problem instanceof Error ? problem.message : String(problem));
      }
    };
    void readTicket();

    const stream = new EventSource(timelineUrl(id, 0));
    stream.onmessage = (frame: MessageEvent<string>) => {
      const entry = parseTimelineFrame(frame.data);
      if (!entry || !watching) return;
      setEntries((held) => mergeEntries(held, [entry]));
      if (entry.type === "status") void readTicket();
    };

    return () => {
      watching = false;
      stream.close();
    };
  }, [id]);

  return { ticket, entries, error };
}
