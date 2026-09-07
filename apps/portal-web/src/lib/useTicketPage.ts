import { useCallback, useEffect, useRef, useState } from "react";
import {
  decide,
  fetchApprovals,
  fetchTicket,
  parseTimelineFrame,
  rerunTicket,
  resolveTicket,
  timelineUrl,
} from "./api";
import {
  type Approval,
  type ManualResolutionInput,
  mergeEntries,
  type ReviewerDecision,
  type Ticket,
  type TimelineEntry,
} from "./tickets";

export type TicketPage = {
  ticket: Ticket | null;
  entries: TimelineEntry[];
  /** Every Proposal this Ticket has raised, newest first. */
  approvals: Approval[];
  error: string | null;
  /** Answers the Proposal the Ticket is waiting on. Throws so the card can say what went wrong. */
  decide: (decision: ReviewerDecision) => Promise<void>;
  /** Finishes an escalated Ticket on what the Reviewer wrote. Throws so the form can say why not. */
  resolve: (resolution: ManualResolutionInput) => Promise<void>;
  /** Runs the Ticket again. The new run's entries arrive on the same open stream. */
  rerun: () => Promise<void>;
};

/**
 * One Ticket, live. The timeline arrives over SSE, which replays whatever the page missed
 * before it goes live, so a reload during a run loses nothing and a dropped connection is
 * the browser's problem: `EventSource` reconnects on its own with the last id it saw.
 *
 * The Ticket row is re-read whenever the lifecycle moves, since that is also when the run's
 * Outcome, Reply and Langfuse trace land on it. Its Proposals are re-read with it: the
 * approval card appears the moment the run stops for one, and goes when it is answered.
 */
export function useTicketPage(id: string): TicketPage {
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [error, setError] = useState<string | null>(null);
  // A Decision re-reads the Ticket without waiting for the next entry. Held in a ref rather
  // than in the effect's dependencies, so answering one does not tear down the live stream.
  const reread = useRef<() => void>(() => {});

  useEffect(() => {
    let watching = true;
    setTicket(null);
    setEntries([]);
    setApprovals([]);
    setError(null);

    const readTicket = async () => {
      try {
        const [found, raised] = await Promise.all([fetchTicket(id), fetchApprovals(id)]);
        if (!watching) return;
        setTicket(found);
        setApprovals(raised);
      } catch (error) {
        if (watching) setError(error instanceof Error ? error.message : String(error));
      }
    };
    reread.current = () => void readTicket();
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
      reread.current = () => {};
      stream.close();
    };
  }, [id]);

  const answer = useCallback(
    async (decision: ReviewerDecision) => {
      await decide(id, decision);
      reread.current();
    },
    [id],
  );

  const resolve = useCallback(
    async (resolution: ManualResolutionInput) => {
      setTicket(await resolveTicket(id, resolution));
    },
    [id],
  );

  // The reopened row comes back from the re-run, so the page shows the Ticket running again
  // without waiting for the new run's first entry to reach the stream.
  const rerun = useCallback(async () => {
    setTicket(await rerunTicket(id));
  }, [id]);

  return { ticket, entries, approvals, error, decide: answer, resolve, rerun };
}
