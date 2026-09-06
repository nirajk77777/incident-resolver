import {
  CategoryMark,
  Field,
  OutcomeMark,
  Problem,
  SourceMark,
  StatusPill,
  TraceLink,
} from "../components/chrome";
import { Timeline } from "../components/Timeline";
import type { PortalConfig } from "../lib/api";
import { grafanaTraceUrl, langfuseTraceUrl } from "../lib/links";
import { linkProps } from "../lib/navigation";
import type { Route } from "../lib/routes";
import {
  confidenceLabel,
  type EvidenceReference,
  isRunning,
  shortId,
  type Ticket,
  type TimelineEntry,
} from "../lib/tickets";
import { clockTime } from "../lib/time";
import { useTicketPage } from "../lib/useTicketPage";

/**
 * One Ticket, as it is investigated. The Timeline is the page: what the Resolver did, in the
 * order it did it. The panel beside it holds what the Ticket ends as — Outcome, Confidence,
 * root cause and the Reply — and fills in as the run reaches them.
 */
export function TicketPage({
  id,
  config,
  go,
}: {
  id: string;
  config: PortalConfig | null;
  go: (route: Route) => void;
}) {
  const { ticket, entries, error } = useTicketPage(id);

  if (error) return <Problem message={error} />;
  if (!ticket) return <p className="py-16 text-center text-[13px] text-muted">Loading…</p>;

  const running = isRunning(ticket);
  return (
    <article>
      <a {...linkProps({ page: "tickets" }, go)} className="eyebrow inline-block hover:text-ink">
        ← Queue
      </a>

      <header className="mt-3 border-b border-rule pb-5">
        <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-mono text-[11px] text-muted">{shortId(ticket.id)}</span>
          <SourceMark source={ticket.source} />
          <span className="font-mono text-[11px] text-muted">
            filed {clockTime(ticket.createdAt)}
          </span>
          {ticket.reporterEmail && (
            <span className="font-mono text-[11px] text-muted">{ticket.reporterEmail}</span>
          )}
        </p>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
          <h2 className="m-0 max-w-2xl text-[27px] leading-tight font-semibold tracking-tight">
            {ticket.title}
          </h2>
          <StatusPill status={ticket.status} />
        </div>
        <p className="mt-3 mb-0 max-w-2xl font-serif text-[15.5px] leading-relaxed whitespace-pre-line text-ink/85">
          {ticket.body}
        </p>
        <Traces ticket={ticket} config={config} />
      </header>

      <div className="mt-6 grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section>
          <h3 className="eyebrow mb-4">Timeline</h3>
          <Timeline entries={entries} running={running} />
        </section>
        <aside className="lg:sticky lg:top-6 lg:self-start">
          <Resolution ticket={ticket} entries={entries} />
        </aside>
      </div>
    </article>
  );
}

/**
 * Both trace ids a Ticket can carry: the ShopLite request the Reporter hit, and the Resolver
 * run that investigated it. Each appears only once there is one to point at.
 */
function Traces({ ticket, config }: { ticket: Ticket; config: PortalConfig | null }) {
  const traces = [
    {
      key: "langfuse",
      label: "Resolver run in Langfuse",
      id: ticket.langfuseTraceId,
      href:
        config && ticket.langfuseTraceId
          ? langfuseTraceUrl(config.langfuseBaseUrl, ticket.langfuseTraceId)
          : undefined,
    },
    {
      key: "grafana",
      label: "ShopLite trace in Grafana",
      id: ticket.traceId,
      href:
        config && ticket.traceId ? grafanaTraceUrl(config.grafanaUrl, ticket.traceId) : undefined,
    },
  ].filter((trace) => trace.id !== null);

  if (traces.length === 0) return null;
  return (
    <div className="mt-4 flex flex-wrap gap-2">
      {traces.map((trace) => (
        <TraceLink key={trace.key} label={trace.label} id={trace.id ?? ""} href={trace.href} />
      ))}
    </div>
  );
}

/** The Evidence the Verdict rests on, which only the Verdict entry carries. */
function evidenceOf(entries: TimelineEntry[]): EvidenceReference[] {
  const verdict = [...entries].reverse().find((entry) => entry.type === "verdict");
  const evidence = verdict?.payload.evidence;
  return Array.isArray(evidence) ? (evidence as EvidenceReference[]) : [];
}

function Resolution({ ticket, entries }: { ticket: Ticket; entries: TimelineEntry[] }) {
  const evidence = evidenceOf(entries);
  const settled = ticket.outcome !== null;

  return (
    <div className="border border-rule bg-card">
      <h3 className="eyebrow border-b border-rule px-4 py-3">Resolution</h3>
      <div className="space-y-5 px-4 py-4">
        {!settled && (
          <p className="m-0 text-[13px] text-muted">
            The Resolver has not reached a Verdict yet. Outcome, Confidence and the Reply appear
            here when it does.
          </p>
        )}

        <div className="grid grid-cols-2 gap-4">
          <Field label="Outcome">
            <OutcomeMark outcome={ticket.outcome} />
          </Field>
          <Field label="Category">
            <CategoryMark category={ticket.category} />
          </Field>
        </div>

        <Field label="Confidence">
          <Confidence confidence={ticket.confidence} />
        </Field>

        {ticket.rootCause && (
          <Field label="Root cause">
            <p className="m-0 font-serif text-[15px] leading-relaxed text-ink">
              {ticket.rootCause}
            </p>
          </Field>
        )}

        {ticket.reply && (
          <Field label={ticket.source === "customer" ? "Reply to the Reporter" : "Internal reply"}>
            <blockquote className="m-0 border-l-2 border-accent pl-3 font-serif text-[15px] leading-relaxed text-ink">
              {ticket.reply}
            </blockquote>
          </Field>
        )}

        {evidence.length > 0 && (
          <Field label="Evidence">
            <ul className="m-0 list-none space-y-3 p-0">
              {evidence.map((item) => (
                <li key={`${item.fact}·${item.provenance}`}>
                  <p className="m-0 text-[13px] leading-snug text-ink">{item.fact}</p>
                  <p className="evidence m-0 mt-1 break-words text-signal">{item.provenance}</p>
                </li>
              ))}
            </ul>
          </Field>
        )}
      </div>
    </div>
  );
}

/** Confidence as a bar as well as a number: the threshold is what decides an escalation. */
function Confidence({ confidence }: { confidence: number | null }) {
  const filled = Math.round((confidence ?? 0) * 100);
  return (
    <div className="flex items-center gap-3">
      <span aria-hidden className="h-1.5 flex-1 bg-well">
        <span
          className="block h-full bg-accent"
          style={{ width: `${confidence === null ? 0 : filled}%` }}
        />
      </span>
      <span className="font-mono text-[12px] text-ink">{confidenceLabel(confidence)}</span>
    </div>
  );
}
