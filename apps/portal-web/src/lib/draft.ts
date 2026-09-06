/**
 * What a tester types before it is a Ticket, and the Ticket body it becomes. The Resolver
 * reads one body, so the steps are folded into it under a heading it can see, rather than
 * being dropped or run together with what went wrong.
 */
export type TicketDraft = {
  summary: string;
  /** What happened, in the tester's own words. */
  what: string;
  /** How to make it happen again. Optional: plenty of tickets are one observation. */
  steps?: string;
  /** The ShopLite trace id from the storefront's error toast, when the tester had one. */
  traceId?: string;
};

export const STEPS_HEADING = "Steps to reproduce";

/** The Ticket body a draft becomes. */
export function draftBody({ what, steps }: TicketDraft): string {
  const reproduction = steps?.trim();
  if (!reproduction) return what.trim();
  return `${what.trim()}\n\n${STEPS_HEADING}:\n${reproduction}`;
}

/** What is missing before the draft can be filed, in the order the fields are asked for. */
export function draftProblems(draft: TicketDraft): string[] {
  const missing: string[] = [];
  if (draft.summary.trim().length === 0) missing.push("Give the ticket a summary");
  if (draft.what.trim().length === 0) missing.push("Say what went wrong");
  return missing;
}
