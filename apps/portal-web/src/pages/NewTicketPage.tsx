import { type FormEvent, useState } from "react";
import { fileTicket } from "../lib/api";
import { reportBody, reportProblems, type TesterReport } from "../lib/report";
import type { Route } from "../lib/routes";
import { linkProps } from "../navigation";

const blank: TesterReport = { summary: "", what: "", steps: "", traceId: "" };

/**
 * How a tester files a Ticket. Summary and report are what the Resolver needs; steps and a
 * trace id are what a tester often has and should not have to leave out. Filing it starts
 * the run, so the form hands straight over to the Ticket's Timeline.
 */
export function NewTicketPage({ go }: { go: (route: Route) => void }) {
  const [report, setReport] = useState<TesterReport>(blank);
  const [problems, setProblems] = useState<string[]>([]);
  const [filing, setFiling] = useState(false);

  const set = (field: keyof TesterReport) => (value: string) =>
    setReport((held) => ({ ...held, [field]: value }));

  async function file(event: FormEvent) {
    event.preventDefault();
    const missing = reportProblems(report);
    setProblems(missing);
    if (missing.length > 0) return;

    setFiling(true);
    try {
      const traceId = report.traceId?.trim();
      const filed = await fileTicket({
        source: "tester",
        title: report.summary.trim(),
        body: reportBody(report),
        ...(traceId ? { traceId } : {}),
      });
      go({ page: "ticket", id: filed.id });
    } catch (problem) {
      setProblems([problem instanceof Error ? problem.message : String(problem)]);
      setFiling(false);
    }
  }

  return (
    <section className="max-w-2xl">
      <a {...linkProps({ page: "tickets" }, go)} className="eyebrow inline-block hover:text-ink">
        ← Queue
      </a>
      <h2 className="mt-3 mb-1 text-[22px] font-semibold tracking-tight">File a ticket</h2>
      <p className="mt-0 mb-6 max-w-lg font-serif text-[15px] leading-relaxed text-muted">
        Describe what you saw. The Resolver triages it, investigates the logs, the database and past
        Incidents, and writes back on this Ticket's Timeline.
      </p>

      {problems.length > 0 && (
        <ul className="m-0 mb-5 list-none border border-warn/40 bg-warn/5 px-4 py-3">
          {problems.map((problem) => (
            <li key={problem} className="text-[13px] text-warn">
              {problem}
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={file} className="space-y-5" noValidate>
        <TextField
          label="Summary"
          hint="One line, the way you would title a bug"
          value={report.summary}
          onChange={set("summary")}
        />
        <TextArea
          label="What went wrong"
          hint="What you did, what you expected, what happened instead"
          rows={6}
          value={report.what}
          onChange={set("what")}
        />
        <TextArea
          label="Steps to reproduce"
          hint="Optional"
          rows={4}
          value={report.steps ?? ""}
          onChange={set("steps")}
        />
        <TextField
          label="ShopLite trace id"
          hint="Optional. The id from the storefront's error message"
          mono
          value={report.traceId ?? ""}
          onChange={set("traceId")}
        />

        <div className="flex items-center gap-4 border-t border-rule pt-5">
          <button
            type="submit"
            disabled={filing}
            className="bg-ink px-4 py-2 text-[13px] font-medium text-paper transition-colors hover:bg-accent disabled:opacity-50"
          >
            {filing ? "Filing…" : "File the ticket"}
          </button>
          <span className="text-[12px] text-muted">The run starts as soon as it is filed.</span>
        </div>
      </form>
    </section>
  );
}

type FieldProps = {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  mono?: boolean;
};

function TextField({ label, hint, value, onChange, mono }: FieldProps) {
  return (
    <label className="block">
      <span className="eyebrow">{label}</span>
      {hint && <span className="mt-1 block text-[12px] text-muted">{hint}</span>}
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={`mt-2 w-full border border-rule bg-card px-3 py-2 text-[14px] text-ink focus:border-accent ${
          mono ? "font-mono text-[12px]" : ""
        }`}
      />
    </label>
  );
}

function TextArea({ label, hint, value, onChange, rows }: FieldProps & { rows: number }) {
  return (
    <label className="block">
      <span className="eyebrow">{label}</span>
      {hint && <span className="mt-1 block text-[12px] text-muted">{hint}</span>}
      <textarea
        rows={rows}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-2 w-full resize-y border border-rule bg-card px-3 py-2 text-[14px] leading-relaxed text-ink focus:border-accent"
      />
    </label>
  );
}
