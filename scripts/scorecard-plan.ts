import type { IncidentCategory, Outcome } from "@incident-resolver/shared";

/**
 * What the scorecard expects of each planted bug, and how a closed Ticket is marked against
 * it. Kept apart from the script that runs them so the expectations can be read, and the
 * marking tested, without a portal, a model, or a database.
 *
 * The planted bugs are PLAN.md section 8. Each one is a Ticket in `packages/agents/tickets/`
 * worded the way its Reporter would word it, so the run under test is the demo's run.
 */

export type PlantedBug = {
  /** The name the scorecard prints and `--only` matches on. */
  key: string;
  /** The Ticket file, relative to the repository root. */
  ticket: string;
  what: string;
  expectedCategory: IncidentCategory;
  /**
   * Every Outcome that counts as the agent having done its job. A list rather than one
   * value because a bug can honestly end more than one way; today none of them does.
   */
  expectedOutcomes: Outcome[];
  /** Why those Outcomes, printed under a failure so the run is readable without PLAN.md. */
  because: string;
};

export const plantedBugs: PlantedBug[] = [
  {
    key: "declined-card",
    ticket: "packages/agents/tickets/declined-card.json",
    what: "A declined card shows a generic 'Checkout failed'",
    expectedCategory: "user_error",
    expectedOutcomes: ["answered"],
    because:
      "The gateway declined the card and said why on the payment row and in the logs. " +
      "Nothing in ShopLite is broken, so the Reporter gets the explanation the UI hid.",
  },
  {
    key: "stale-cart-total",
    ticket: "packages/agents/tickets/stale-cart-total.json",
    what: "cart_totals goes stale when a line is removed",
    expectedCategory: "data_issue",
    expectedOutcomes: ["data_fixed"],
    because:
      "A past Incident documents the UPDATE that corrects the row. The Proposal goes to the " +
      "approval gate, the scorecard approves it, and the fix runs.",
  },
  {
    key: "double-discount",
    ticket: "packages/agents/tickets/double-discount.json",
    what: "The discount comes off twice on the order",
    expectedCategory: "code_bug",
    expectedOutcomes: ["fix_proposed"],
    because:
      "Code RCA clones ShopLite, writes the failing test, and patches the defect; the Fix " +
      "Shipper pushes it and the approved pull request opens. A Ticket cannot close " +
      "fix_proposed unless one actually did, so this row failing as escalated means either " +
      "GITHUB_TOKEN is unset or the run never got the patch green.",
  },
  {
    key: "empty-cart-crash",
    ticket: "packages/agents/tickets/empty-cart-crash.json",
    what: "Checking out an empty cart crashes the route",
    expectedCategory: "code_bug",
    expectedOutcomes: ["fix_proposed"],
    because:
      "The same path as the double discount. This is the bug Sentinel finds by itself on " +
      "the demo; the scorecard files it directly so it is graded without waiting for traffic.",
  },
];

/** A Ticket as the scorecard reads it back off the portal once it has closed. */
export type ClosedTicket = {
  id: string;
  category: IncidentCategory | null;
  outcome: Outcome | null;
  confidence: number | null;
};

export type Mark = {
  bug: PlantedBug;
  ticketId: string;
  category: IncidentCategory | null;
  outcome: Outcome | null;
  confidence: number | null;
  categoryPass: boolean;
  outcomePass: boolean;
  pass: boolean;
};

/** Marks one closed Ticket against what its planted bug should have produced. */
export function mark(bug: PlantedBug, ticket: ClosedTicket): Mark {
  const categoryPass = ticket.category === bug.expectedCategory;
  const outcomePass = ticket.outcome !== null && bug.expectedOutcomes.includes(ticket.outcome);
  return {
    bug,
    ticketId: ticket.id,
    category: ticket.category,
    outcome: ticket.outcome,
    confidence: ticket.confidence,
    categoryPass,
    outcomePass,
    pass: categoryPass && outcomePass,
  };
}

/** The scorecard as a table, one row per bug, with a header. */
export function renderScorecard(marks: Mark[]): string {
  const rows = marks.map((found) => [
    found.pass ? "pass" : "FAIL",
    found.bug.key,
    `${found.category ?? "—"}${found.categoryPass ? "" : ` (want ${found.bug.expectedCategory})`}`,
    `${found.outcome ?? "—"}${found.outcomePass ? "" : ` (want ${found.bug.expectedOutcomes.join(" or ")})`}`,
    found.confidence === null ? "—" : found.confidence.toFixed(2),
  ]);
  const header = ["", "bug", "category", "outcome", "confidence"];
  const widths = header.map((_, column) =>
    Math.max(...[header, ...rows].map((row) => (row[column] ?? "").length)),
  );
  const line = (row: string[]) =>
    row
      .map((cell, column) => (cell ?? "").padEnd(widths[column] ?? 0))
      .join("  ")
      .trimEnd();
  return [line(header), ...rows.map(line)].join("\n");
}
