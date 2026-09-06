import { useState } from "react";
import {
  emptyResolution,
  type ResolutionDraft,
  resolutionFor,
  resolutionProblems,
} from "../lib/manual-resolution";
import type { ManualResolutionInput, Ticket } from "../lib/tickets";

/**
 * The other place a human decides. The Resolver gave this Ticket up, and this is where a
 * Reviewer finishes it: what was actually wrong, what fixed it, and the Reply that replaces
 * the holding message the Reporter has been reading.
 *
 * Submitting it also writes the Incident, which is the point of asking for the first two
 * fields rather than only the Reply: what a person worked out here is what the next similar
 * Ticket's Historian finds.
 */
export function ManualResolutionForm({
  onResolve,
}: {
  onResolve: (resolution: ManualResolutionInput) => Promise<void>;
}) {
  const [draft, setDraft] = useState<ResolutionDraft>(emptyResolution);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const missing = resolutionProblems(draft);
  const set = (field: keyof ResolutionDraft) => (value: string) =>
    setDraft((held) => ({ ...held, [field]: value }));

  async function submit() {
    const resolution = resolutionFor(draft);
    if (!resolution) return;
    setSending(true);
    setProblem(null);
    try {
      await onResolve(resolution);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
      setSending(false);
    }
  }

  return (
    <section className="border border-warn/50 bg-warn/5">
      <header className="border-b border-warn/30 px-4 py-3">
        <h3 className="eyebrow m-0 text-warn">Escalated · resolve it yourself</h3>
      </header>

      <div className="space-y-4 px-4 py-4">
        <p className="m-0 font-serif text-[15px] leading-relaxed text-ink">
          The Resolver could not settle this one. What you write here closes the Ticket, replaces
          the holding message the Reporter is reading, and becomes an Incident the next similar
          Ticket will find.
        </p>

        <Line
          label="Root cause"
          placeholder="What was actually wrong"
          value={draft.rootCause}
          onChange={set("rootCause")}
        />
        <Line
          label="Resolution"
          placeholder="What fixed it: the statement you ran, the change you made"
          value={draft.resolution}
          onChange={set("resolution")}
        />
        <Line
          label="Reply to the Reporter"
          placeholder="What the Reporter reads instead of the holding message"
          value={draft.reply}
          onChange={set("reply")}
          serif
        />

        <label className="block">
          <span className="eyebrow">Your name</span>
          <input
            type="text"
            value={draft.author}
            onChange={(event) => set("author")(event.target.value)}
            placeholder="Recorded on the Incident. Left blank, it reads as Reviewer."
            className="mt-2 w-full border border-rule bg-card px-3 py-2 text-[14px] text-ink focus:border-accent"
          />
        </label>

        {problem && (
          <p className="evidence m-0 border border-warn/40 bg-card px-3 py-2 text-warn">
            {problem}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-4 border-t border-warn/30 pt-4">
          <button
            type="button"
            disabled={sending || missing.length > 0}
            onClick={() => void submit()}
            className="bg-ink px-4 py-2 text-[13px] font-medium text-paper transition-colors hover:bg-accent disabled:opacity-50"
          >
            {sending ? "Closing…" : "Resolve and write the Incident"}
          </button>
          {missing.length > 0 && <span className="text-[12px] text-muted">{missing[0]}</span>}
        </div>
      </div>
    </section>
  );
}

function Line({
  label,
  placeholder,
  value,
  onChange,
  serif = false,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  /** The Reply is prose a person will read, so it is set and sized as prose. */
  serif?: boolean;
}) {
  return (
    <label className="block">
      <span className="eyebrow">{label}</span>
      <textarea
        rows={serif ? 6 : 3}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className={`mt-2 w-full resize-y border border-rule bg-card px-3 py-2 text-ink focus:border-accent ${
          serif ? "font-serif text-[15px] leading-relaxed" : "text-[14px]"
        }`}
      />
    </label>
  );
}

/** What a person wrote, once they have. Shown in place of the form on a resolved Ticket. */
export function ManualResolutionPanel({ ticket }: { ticket: Ticket }) {
  if (ticket.resolvedBy !== "human" || !ticket.resolution) return null;
  return (
    <div className="border border-rule bg-card">
      <h3 className="eyebrow border-b border-rule px-4 py-3">Resolved by hand</h3>
      <p className="m-0 px-4 py-4 font-serif text-[15px] leading-relaxed text-ink">
        {ticket.resolution}
      </p>
    </div>
  );
}
