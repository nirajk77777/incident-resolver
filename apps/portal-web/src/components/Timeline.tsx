import type { TimelineEntry } from "../lib/tickets";
import { byRun, cardFor, elapsedLabel, openSubagents, type TimelineCard } from "../lib/timeline";

/**
 * The Timeline, as a transcript: one rail down the left, an elapsed offset in the gutter, and
 * a marker for every entry hanging off the rail. What the Resolver did is the heading and one
 * line of prose; the payload it did it with stays folded away until it is asked for, so a run
 * of forty entries still reads top to bottom.
 */
export function Timeline({ entries, running }: { entries: TimelineEntry[]; running: boolean }) {
  if (entries.length === 0) {
    return (
      <p className="border border-dashed border-rule px-4 py-8 text-center text-[13px] text-muted">
        {running ? "Waiting for the Resolver to start." : "This Ticket has no timeline."}
      </p>
    );
  }

  const runs = byRun(entries);
  return (
    <div className="space-y-8">
      {runs.map(({ run, entries: ofRun }, index) => (
        <section key={run}>
          {runs.length > 1 && <h3 className="eyebrow mb-3 border-b border-rule pb-2">Run {run}</h3>}
          <RunRail
            entries={ofRun}
            // Only the newest run can still be going.
            running={running && index === runs.length - 1}
          />
        </section>
      ))}
    </div>
  );
}

function RunRail({ entries, running }: { entries: TimelineEntry[]; running: boolean }) {
  const open = openSubagents(entries);

  return (
    <ol className="m-0 list-none p-0">
      {entries.map((entry) => (
        <Entry
          key={entry.id}
          entry={entry}
          elapsed={elapsedLabel(entry, entries)}
          card={cardFor(entry)}
          open={open.has(entry.id)}
        />
      ))}
      {running && (
        <li className="grid grid-cols-[3.5rem_1fr] gap-x-3">
          <span />
          <span className="border-l border-rule pl-5">
            <span aria-hidden className="caret inline-block h-3 w-1.5 bg-accent align-middle" />
            <span className="sr-only">The run is still going</span>
          </span>
        </li>
      )}
    </ol>
  );
}

/**
 * How each kind of entry is drawn: the mark on the rail, whose shape says what the entry is
 * before the words do, and the face its heading is set in — names the machine gave itself are
 * set as such, the words it wrote for a person are not.
 */
/** The tool marker's own shape, shared so a refused call is drawn as the same ring. */
const TOOL_MARKER = "h-2 w-2 rounded-full border";

const kinds: Record<TimelineCard["kind"], { marker: string; heading: string }> = {
  subagent: { marker: "h-2.5 w-2.5 rotate-45 bg-accent", heading: "font-mono" },
  tool: { marker: `${TOOL_MARKER} border-signal bg-card`, heading: "font-mono" },
  message: { marker: "h-px w-3 bg-muted", heading: "font-sans tracking-tight" },
  interrupt: {
    marker: "h-2.5 w-2.5 rotate-45 border border-warn bg-warn/15",
    heading: "font-mono",
  },
  decision: { marker: "h-2.5 w-2.5 rotate-45 bg-warn", heading: "font-mono" },
  verdict: { marker: "h-3 w-3 bg-ink", heading: "font-sans tracking-[0.14em] uppercase" },
  status: { marker: "h-1.5 w-1.5 rounded-full bg-rule", heading: "font-sans" },
};

function Entry({
  entry,
  card,
  elapsed,
  open,
}: {
  entry: TimelineEntry;
  card: TimelineCard;
  elapsed: string;
  open: boolean;
}) {
  // A status move is the portal's own bookkeeping, not work: it reads as a rule across the
  // rail rather than as a card, so it separates the work either side of it.
  if (card.kind === "status") {
    return (
      <li className="entry-enter grid grid-cols-[3.5rem_1fr] gap-x-3">
        <span className="pt-1 text-right font-mono text-[11px] text-muted">{elapsed}</span>
        <div className="relative border-l border-rule py-2 pl-5">
          <Marker kind="status" />
          <span className="eyebrow">{card.heading.replace(/_/g, " ")}</span>
        </div>
      </li>
    );
  }

  return (
    <li className="entry-enter grid grid-cols-[3.5rem_1fr] gap-x-3">
      <span className="pt-3 text-right font-mono text-[11px] text-muted">{elapsed}</span>
      <div className="relative border-l border-rule pb-4 pl-5">
        <Marker kind={card.kind} failed={card.failed} />
        <div className={`border bg-card px-4 py-3 ${card.failed ? "border-warn" : "border-rule"}`}>
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <h4 className={`m-0 text-[12.5px] font-semibold text-ink ${kinds[card.kind].heading}`}>
              {card.heading}
              {open && <span className="ml-2 font-sans text-[11px] text-accent">running</span>}
              {card.failed && (
                <span className="ml-2 font-sans text-[11px] text-warn">no answer</span>
              )}
            </h4>
            {kindOf(entry.type) !== card.heading.toLowerCase() && (
              <span className="eyebrow">{kindOf(entry.type)}</span>
            )}
          </div>
          {card.detail && (
            <p className={`mt-2 mb-0 leading-relaxed ${detailFace(card)}`}>{card.detail}</p>
          )}
          {card.link && (
            <p className="mt-2 mb-0">
              <a
                href={card.link}
                target="_blank"
                rel="noreferrer"
                className="evidence text-accent underline underline-offset-2 [overflow-wrap:anywhere]"
              >
                {card.link}
              </a>
            </p>
          )}
          {card.reply && (
            <div className="mt-3">
              <span className="eyebrow">Reply</span>
              <blockquote className="m-0 mt-1.5 border-l-2 border-accent pl-3 font-serif text-[15px] leading-relaxed text-ink">
                {card.reply}
              </blockquote>
            </div>
          )}
          {card.payload && <Payload payload={card.payload} />}
        </div>
      </div>
    </li>
  );
}

/** What kind of entry this is, in words. Left off when the card's own heading already says it. */
const kindOf = (type: TimelineEntry["type"]) => type.replace(/_/g, " ");

function detailFace(card: TimelineCard): string {
  if (card.monoDetail) return "evidence [overflow-wrap:anywhere] text-ink/70";
  if (card.kind === "verdict" || card.kind === "message") return "font-serif text-[15px] text-ink";
  return "text-[13.5px] text-muted";
}

function Marker({ kind, failed }: { kind: TimelineCard["kind"]; failed?: boolean }) {
  // A call that did not answer keeps the tool ring and takes the warning colour, so the rail
  // reads as a tool card that came back empty rather than as some other kind of entry.
  const shape = failed ? `${TOOL_MARKER} border-warn bg-warn/25` : kinds[kind].marker;
  return (
    <span
      aria-hidden
      className={`absolute top-4 -left-[5px] block ${shape}`}
      style={kind === "status" ? { top: "1.1rem", left: "-3px" } : undefined}
    />
  );
}

/**
 * The payload, folded away. Collapsed by default is the point: the Reviewer reads the run,
 * and opens the one card where the Evidence matters.
 */
function Payload({ payload }: { payload: Record<string, unknown> }) {
  return (
    <details className="mt-3 group">
      <summary className="eyebrow cursor-pointer list-none select-none marker:hidden hover:text-ink">
        <span className="group-open:hidden">Show payload</span>
        <span className="hidden group-open:inline">Hide payload</span>
      </summary>
      <pre className="evidence mt-2 max-h-80 overflow-auto border border-rule bg-well px-3 py-2 whitespace-pre-wrap">
        {format(payload)}
      </pre>
    </details>
  );
}

function format(payload: Record<string, unknown>): string {
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}
