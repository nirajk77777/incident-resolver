import { useEffect, useState } from "react";
import {
  CategoryMark,
  OutcomeMark,
  Problem,
  SourceMark,
  StatusPill,
  statusSpine,
} from "../components/chrome";
import { fetchTickets } from "../lib/api";
import { linkProps } from "../lib/navigation";
import type { Route } from "../lib/routes";
import { confidenceLabel, isRunning, shortId, type Ticket } from "../lib/tickets";
import { relativeTime } from "../lib/time";

/**
 * The queue. Every Ticket the portal knows, newest first, with the four things a Reviewer
 * scans for: where it is, what it turned out to be, how it ended, and how sure the Resolver
 * was. The list re-reads itself while anything is still running, so a Ticket filed in
 * another tab appears without a reload.
 */
export function TicketsPage({ go }: { go: (route: Route) => void }) {
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let watching = true;
    const read = async () => {
      try {
        const found = await fetchTickets();
        if (watching) {
          setTickets(found);
          setError(null);
        }
      } catch (error) {
        if (watching) setError(error instanceof Error ? error.message : String(error));
      }
    };
    void read();
    const timer = setInterval(read, 4000);
    return () => {
      watching = false;
      clearInterval(timer);
    };
  }, []);

  if (error) return <Problem message={error} />;
  if (tickets === null) return <p className="py-16 text-center text-[13px] text-muted">Loading…</p>;
  if (tickets.length === 0) return <Empty go={go} />;

  const open = tickets.filter(isRunning).length;
  return (
    <section>
      <header className="mb-5 flex items-baseline justify-between border-b border-rule pb-3">
        <h2 className="m-0 text-[22px] font-semibold tracking-tight">Queue</h2>
        <p className="m-0 font-mono text-[11px] text-muted">
          {tickets.length} tickets · {open} still running
        </p>
      </header>

      <div className="hidden grid-cols-[1fr_7rem_7rem_5rem_5.5rem] gap-4 px-4 pb-2 md:grid">
        <span className="eyebrow">Ticket</span>
        <span className="eyebrow">Status</span>
        <span className="eyebrow">Category</span>
        <span className="eyebrow">Outcome</span>
        <span className="eyebrow text-right">Confidence</span>
      </div>

      <ul className="m-0 list-none space-y-px p-0">
        {tickets.map((ticket) => (
          <li key={ticket.id}>
            <a
              {...linkProps({ page: "ticket", id: ticket.id }, go)}
              className="flex flex-col gap-3 border border-rule bg-card px-4 py-3 transition-colors hover:border-ink/25 md:grid md:grid-cols-[1fr_7rem_7rem_5rem_5.5rem] md:items-center md:gap-x-4"
            >
              <span className="flex items-start gap-3">
                <span
                  aria-hidden
                  className={`mt-1 h-8 w-[3px] shrink-0 ${statusSpine(ticket.status)}`}
                />
                <span>
                  <span className="block text-[15px] leading-snug font-medium text-ink">
                    {ticket.title}
                  </span>
                  <span className="mt-1 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                    <span className="font-mono text-[11px] text-muted">{shortId(ticket.id)}</span>
                    <SourceMark source={ticket.source} />
                    <span className="font-mono text-[11px] text-muted">
                      {relativeTime(ticket.createdAt)}
                    </span>
                  </span>
                </span>
              </span>
              {/*
                Four columns on a desktop queue; on a narrow screen the wrapper dissolves into
                one meta row, and the columns a Ticket has nothing in yet are left off rather
                than stacking up as em dashes.
              */}
              <span className="flex flex-wrap items-center gap-x-4 gap-y-2 md:contents">
                <span className="md:justify-self-start">
                  <StatusPill status={ticket.status} />
                </span>
                <span className={ticket.category === null ? "max-md:hidden" : undefined}>
                  <CategoryMark category={ticket.category} />
                </span>
                <span className={ticket.outcome === null ? "max-md:hidden" : undefined}>
                  <OutcomeMark outcome={ticket.outcome} />
                </span>
                <span
                  className={`font-mono text-[12px] text-ink md:text-right ${
                    ticket.confidence === null ? "max-md:hidden" : ""
                  }`}
                >
                  {confidenceLabel(ticket.confidence)}
                </span>
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Empty({ go }: { go: (route: Route) => void }) {
  return (
    <div className="border border-dashed border-rule px-6 py-20 text-center">
      <p className="m-0 text-[15px] text-ink">The queue is empty.</p>
      <p className="mt-2 mb-5 text-[13px] text-muted">
        File one and watch the Resolver investigate it.
      </p>
      <a
        {...linkProps({ page: "new-ticket" }, go)}
        className="inline-block bg-ink px-4 py-2 text-[13px] font-medium text-paper hover:bg-accent"
      >
        File a ticket
      </a>
    </div>
  );
}
