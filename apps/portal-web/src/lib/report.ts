/**
 * What a tester types, and the Ticket it becomes. The Resolver reads one body, so the steps
 * are folded into it under a heading it can see, rather than being dropped or run together
 * with the report.
 */
export type TesterReport = {
  summary: string;
  /** What happened, in the tester's own words. */
  what: string;
  /** How to make it happen again. Optional: plenty of reports are one observation. */
  steps?: string;
  /** The ShopLite trace id from the storefront's error toast, when the tester had one. */
  traceId?: string;
};

export const STEPS_HEADING = "Steps to reproduce";

/** The Ticket body a report becomes. */
export function reportBody({ what, steps }: TesterReport): string {
  const reproduction = steps?.trim();
  if (!reproduction) return what.trim();
  return `${what.trim()}\n\n${STEPS_HEADING}:\n${reproduction}`;
}

/** What is missing before the report can be filed, in the order the fields are asked for. */
export function reportProblems(report: TesterReport): string[] {
  const problems: string[] = [];
  if (report.summary.trim().length === 0) problems.push("Give the report a summary");
  if (report.what.trim().length === 0) problems.push("Say what went wrong");
  return problems;
}
