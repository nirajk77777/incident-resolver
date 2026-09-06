import type { Approval, Proposal } from "./tickets";

/**
 * What the approval card reasons about, kept out of the component so it can be read and
 * tested on its own. The card itself is the Reviewer's one decision point in the whole
 * system, so what it may change, and what it sends back when it does, is written down here.
 */

/** Whether this Proposal is one the Reviewer can reword before approving it. */
export function isEditable(approval: Approval): boolean {
  return (
    approval.allowedDecisions.includes("edit") && editableText(approval.proposal) !== undefined
  );
}

/** The one field of a Proposal a Reviewer edits: the statement, or the wording of the Reply. */
export function editableText(proposal: Proposal): string | undefined {
  if (proposal.kind === "data_fix") return proposal.sql;
  if (proposal.kind === "reply") return proposal.text;
  return undefined;
}

/**
 * The Proposal as the Reviewer left it. Everything but the one field they edited is carried
 * through unchanged; the portal reads the statement again and re-checks it against the guard,
 * so what the card sends is a wording, not a claim about what it does.
 */
export function editedProposalFor(proposal: Proposal, text: string): Proposal {
  if (proposal.kind === "data_fix") return { ...proposal, sql: text };
  if (proposal.kind === "reply") return { ...proposal, text };
  return proposal;
}

/** The columns of a preview table: every key any row has, in the order they first appear. */
export function columnsOf(rows: Array<Record<string, unknown>>): string[] {
  const columns: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!columns.includes(key)) columns.push(key);
    }
  }
  return columns;
}

/** One cell of the preview, as text. Nulls read as an em dash rather than as the word null. */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
