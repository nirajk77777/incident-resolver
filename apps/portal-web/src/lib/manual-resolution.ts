import type { ManualResolutionInput } from "./tickets";

/**
 * What a Reviewer types to finish an escalated Ticket, before it is a resolution. The three
 * fields are the three the Incident is written from, so none of them is optional: a record with
 * a blank root cause teaches the next search nothing.
 */
export type ResolutionDraft = {
  rootCause: string;
  resolution: string;
  reply: string;
  /** Who resolved it, recorded on the Incident. The portal has no login, so it is typed. */
  author: string;
};

export const emptyResolution: ResolutionDraft = {
  rootCause: "",
  resolution: "",
  reply: "",
  author: "",
};

/** What is missing before it can be submitted, in the order the fields are asked for. */
export function resolutionProblems(draft: ResolutionDraft): string[] {
  const missing: string[] = [];
  if (draft.rootCause.trim().length === 0) missing.push("Say what was actually wrong");
  if (draft.resolution.trim().length === 0) missing.push("Say what fixed it");
  if (draft.reply.trim().length === 0) missing.push("Write the Reply the Reporter reads");
  return missing;
}

/**
 * The resolution the draft becomes. An unnamed Reviewer is left out rather than sent blank, so
 * the portal's own default is what ends up on the Incident.
 */
export function resolutionFor(draft: ResolutionDraft): ManualResolutionInput | undefined {
  if (resolutionProblems(draft).length > 0) return undefined;
  const author = draft.author.trim();
  return {
    rootCause: draft.rootCause.trim(),
    resolution: draft.resolution.trim(),
    reply: draft.reply.trim(),
    ...(author.length > 0 ? { author } : {}),
  };
}
