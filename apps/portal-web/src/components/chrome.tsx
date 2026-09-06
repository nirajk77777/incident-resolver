import type { ReactNode } from "react";
import {
  type Category,
  categoryLabel,
  type Outcome,
  outcomeLabel,
  sourceLabel,
  statusLabel,
  type TicketSource,
  type TicketStatus,
} from "../lib/tickets";

/** The colour a status carries wherever it appears: the queue's spine, the Ticket's pill. */
const statusInk: Record<TicketStatus, string> = {
  new: "text-muted",
  triaging: "text-signal",
  investigating: "text-signal",
  awaiting_approval: "text-warn",
  acting: "text-accent",
  closed: "text-ink",
};

const statusEdge: Record<TicketStatus, string> = {
  new: "bg-rule",
  triaging: "bg-signal",
  investigating: "bg-signal",
  awaiting_approval: "bg-warn",
  acting: "bg-accent",
  closed: "bg-ink",
};

export const statusColor = (status: TicketStatus) => statusInk[status];
export const statusSpine = (status: TicketStatus) => statusEdge[status];

/** Where the Ticket is now. A run still moving carries the caret; a closed one is still. */
export function StatusPill({ status }: { status: TicketStatus }) {
  const running = status !== "closed";
  return (
    <span
      className={`inline-flex items-center gap-2 border border-rule bg-card px-2.5 py-1 font-mono text-[11px] ${statusInk[status]}`}
    >
      <span
        aria-hidden
        className={`inline-block h-1.5 w-1.5 rounded-full ${statusEdge[status]} ${running ? "caret" : ""}`}
      />
      {statusLabel(status)}
    </span>
  );
}

/** How a Ticket ended. Escalated is the one a human still has to pick up, so it is marked. */
export function OutcomeMark({ outcome }: { outcome: Outcome | null }) {
  if (outcome === null) return <span className="text-muted">—</span>;
  const escalated = outcome === "escalated";
  return (
    <span
      className={`font-mono text-[11px] ${escalated ? "text-warn" : "text-ink"}`}
      title={escalated ? "A human resolves this one" : undefined}
    >
      {outcomeLabel(outcome)}
    </span>
  );
}

export function CategoryMark({ category }: { category: Category | null }) {
  if (category === null) return <span className="text-muted">—</span>;
  return <span className="font-mono text-[11px] text-muted">{categoryLabel(category)}</span>;
}

/** Where the Ticket came from. Set as a label rather than an icon: three sources, three words. */
export function SourceMark({ source }: { source: TicketSource }) {
  return <span className="eyebrow">{sourceLabel(source)}</span>;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="eyebrow">{label}</div>
      <div>{children}</div>
    </div>
  );
}

/** A link out of the portal, to the trace that holds the rest of the story. */
export function TraceLink({ href, label, id }: { href: string; label: string; id: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="group inline-flex items-baseline gap-2 border border-rule bg-card px-3 py-2 transition-colors hover:border-signal"
    >
      <span className="text-[12px] font-medium text-signal group-hover:underline">{label}</span>
      <span className="font-mono text-[11px] text-muted">{id.slice(0, 12)}…</span>
      <span aria-hidden className="text-[11px] text-muted">
        ↗
      </span>
    </a>
  );
}
