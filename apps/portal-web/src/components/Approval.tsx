import { useState } from "react";
import { cellText, columnsOf, editableText, editedProposalFor, isEditable } from "../lib/approval";
import {
  type Approval,
  actionLabel,
  type DataFixPreview,
  decisionLabel,
  type Proposal,
  type ReviewerDecision,
} from "../lib/tickets";

/**
 * The one place a human decides. The run has stopped and is holding a write; this card is
 * what it is holding, what it would do, and the three answers a Reviewer can give.
 *
 * It is deliberately the loudest thing on the Ticket page: an unapproved write is the only
 * state in the system that needs a person, and a Reviewer should not have to look for it.
 */
export function ApprovalCard({
  approval,
  onDecide,
}: {
  approval: Approval;
  onDecide: (decision: ReviewerDecision) => Promise<void>;
}) {
  const [text, setText] = useState(editableText(approval.proposal) ?? "");
  const [reason, setReason] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const editable = isEditable(approval);
  const original = editableText(approval.proposal) ?? "";
  const edited = editable && text.trim() !== original.trim();
  const canReject = approval.allowedDecisions.includes("reject");

  async function send(decision: ReviewerDecision) {
    setSending(true);
    setProblem(null);
    try {
      await onDecide(decision);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
      setSending(false);
    }
  }

  const approve = () =>
    send(
      edited
        ? { decision: "edit", proposal: editedProposalFor(approval.proposal, text.trim()) }
        : { decision: "approve" },
    );

  return (
    <section className="border border-warn/50 bg-warn/5">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-warn/30 px-4 py-3">
        <h3 className="eyebrow m-0 text-warn">{actionLabel(approval.action)} · waiting for you</h3>
        <span className="font-mono text-[11px] text-muted">Run {approval.run}</span>
      </header>

      <div className="space-y-4 px-4 py-4">
        <Reason proposal={approval.proposal} />

        {editable ? (
          <label className="block">
            <span className="eyebrow">
              {approval.proposal.kind === "data_fix" ? "Statement" : "Reply"}
            </span>
            <textarea
              rows={approval.proposal.kind === "data_fix" ? 5 : 7}
              value={text}
              spellCheck={approval.proposal.kind !== "data_fix"}
              onChange={(event) => setText(event.target.value)}
              className={`mt-2 w-full resize-y border border-rule bg-card px-3 py-2 text-ink focus:border-accent ${
                approval.proposal.kind === "data_fix"
                  ? "evidence"
                  : "font-serif text-[15px] leading-relaxed"
              }`}
            />
            {edited && (
              <span className="mt-1 block text-[12px] text-warn">
                Edited. Approving runs your version, not the agent's.
              </span>
            )}
          </label>
        ) : (
          <PullRequest proposal={approval.proposal} />
        )}

        <Preview preview={approval.preview} />

        {problem && (
          <p className="evidence m-0 border border-warn/40 bg-card px-3 py-2 text-warn">
            {problem}
          </p>
        )}

        {rejecting ? (
          <div className="space-y-2 border-t border-warn/30 pt-4">
            <label className="block">
              <span className="eyebrow">Why not</span>
              <input
                type="text"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="The agent reads this and decides what to do instead"
                className="mt-2 w-full border border-rule bg-card px-3 py-2 text-[14px] text-ink focus:border-accent"
              />
            </label>
            <div className="flex items-center gap-3">
              <button
                type="button"
                disabled={sending || reason.trim().length === 0}
                onClick={() => send({ decision: "reject", reason: reason.trim() })}
                className="bg-warn px-4 py-2 text-[13px] font-medium text-paper transition-colors hover:bg-ink disabled:opacity-50"
              >
                Reject
              </button>
              <button
                type="button"
                onClick={() => setRejecting(false)}
                className="text-[13px] text-muted hover:text-ink"
              >
                Back
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-4 border-t border-warn/30 pt-4">
            <button
              type="button"
              disabled={sending}
              onClick={approve}
              className="bg-ink px-4 py-2 text-[13px] font-medium text-paper transition-colors hover:bg-accent disabled:opacity-50"
            >
              {sending ? "Sending…" : edited ? "Approve my version" : "Approve"}
            </button>
            {canReject && (
              <button
                type="button"
                disabled={sending}
                onClick={() => setRejecting(true)}
                className="text-[13px] text-muted hover:text-warn disabled:opacity-50"
              >
                Reject
              </button>
            )}
            <span className="text-[12px] text-muted">
              {approval.action === "apply_data_fix"
                ? "Runs in one transaction, with the old rows kept."
                : "The run carries on as soon as you answer."}
            </span>
          </div>
        )}
      </div>
    </section>
  );
}

/** Why the agent wants this. For a pull request the branch and files are the whole of it. */
function Reason({ proposal }: { proposal: Proposal }) {
  if (proposal.kind === "pull_request") return null;
  const reason = proposal.kind === "data_fix" ? proposal.reason : undefined;
  return (
    <>
      {reason && <p className="m-0 font-serif text-[15px] leading-relaxed text-ink">{reason}</p>}
      {proposal.kind === "data_fix" && (
        <p className="m-0 font-mono text-[11px] text-muted">
          {proposal.statement.toUpperCase()} on {proposal.table || "an unreadable table"}
          {proposal.matchingRows === null ? "" : ` · ${proposal.matchingRows} row(s) matched`}
        </p>
      )}
    </>
  );
}

/** A pull request is taken or left as the agent wrote it, so it is shown, not offered for editing. */
function PullRequest({ proposal }: { proposal: Proposal }) {
  if (proposal.kind !== "pull_request") return null;
  return (
    <div className="space-y-3">
      <p className="m-0 text-[14px] font-medium text-ink">{proposal.title}</p>
      <p className="m-0 font-mono text-[11px] text-muted">
        {proposal.branch} · {proposal.files.length} file(s)
      </p>
      <pre className="evidence m-0 max-h-64 overflow-auto border border-rule bg-card px-3 py-2 whitespace-pre-wrap">
        {proposal.body}
      </pre>
      {proposal.files.length > 0 && (
        <ul className="m-0 list-none space-y-0.5 p-0">
          {proposal.files.map((file) => (
            <li key={file} className="evidence text-signal">
              {file}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The rows the fix would touch, as they are now. This is what makes the Decision an informed
 * one rather than a reading of the SQL: the Reviewer sees what is about to change.
 */
function Preview({ preview }: { preview: DataFixPreview | null }) {
  if (!preview) return null;
  if (preview.refused) {
    return (
      <div className="border border-warn/40 bg-card px-3 py-2">
        <p className="eyebrow m-0 text-warn">The portal will not run this</p>
        <p className="evidence m-0 mt-1 text-ink">{preview.refused}</p>
      </div>
    );
  }

  const rows = preview.rows ?? [];
  const columns = columnsOf(rows);
  return (
    <div>
      <span className="eyebrow">
        Rows it would change{preview.table ? ` · ${preview.table}` : ""}
      </span>
      {rows.length === 0 ? (
        <p className="evidence m-0 mt-2 text-muted">
          Nothing matches this statement now, so it would change no rows.
        </p>
      ) : (
        <div className="mt-2 overflow-x-auto border border-rule bg-card">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr>
                {columns.map((column) => (
                  <th
                    key={column}
                    className="eyebrow border-b border-rule px-3 py-2 whitespace-nowrap"
                  >
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={columns.map((column) => cellText(row[column])).join("·") || index}>
                  {columns.map((column) => (
                    <td
                      key={column}
                      className="evidence border-b border-rule px-3 py-1.5 whitespace-nowrap text-ink"
                    >
                      {cellText(row[column])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** What a Reviewer already decided, on the Ticket after the fact. */
export function DecidedApproval({ approval }: { approval: Approval }) {
  if (!approval.decision) return null;
  const ran = approval.result as { ran?: boolean; rowCount?: number; reason?: string } | null;
  return (
    <div className="border border-rule bg-card px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-[12.5px] font-medium text-ink">
          {actionLabel(approval.action)} · {decisionLabel(approval.decision)}
        </span>
        <span className="eyebrow">Run {approval.run}</span>
      </div>
      {approval.reason && <p className="m-0 mt-1.5 text-[13px] text-muted">{approval.reason}</p>}
      {ran?.ran === true && (
        <p className="m-0 mt-1.5 font-mono text-[11px] text-muted">
          {ran.rowCount} row(s) changed, kept for rollback
        </p>
      )}
      {ran?.ran === false && (
        <p className="m-0 mt-1.5 font-mono text-[11px] text-warn">{ran.reason}</p>
      )}
    </div>
  );
}
