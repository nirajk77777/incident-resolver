/**
 * Masks card numbers and other people's emails in anything a tool returns, so every
 * result is safe to show on the Ticket timeline. Shared by the database and
 * observability MCP servers. Implemented here, not in a prompt.
 */

export type RedactionOptions = {
  /** The reporter's own email stays visible; every other email is masked. */
  reporterEmail?: string | undefined;
};

export const CARD_MASK = "[redacted card]";
export const EMAIL_MASK = "[redacted email]";

/** Kept verbatim: ids the agent must be able to quote back. */
const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** 13 to 19 digits, optionally separated by single spaces or dashes, standing on their own. */
const cardPattern = /(?<![A-Za-z0-9_])\d(?:[ -]?\d){12,18}(?![A-Za-z0-9_])/g;
const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

/** Returns a copy of `value` with every string inside it redacted. */
export function redact<T>(value: T, options: RedactionOptions): T {
  return walk(value, options.reporterEmail?.toLowerCase()) as T;
}

function walk(value: unknown, reporterEmail: string | undefined): unknown {
  if (typeof value === "string") return redactString(value, reporterEmail);
  if (typeof value === "number") return looksLikeCard(value) ? CARD_MASK : value;
  if (Array.isArray(value)) return value.map((item) => walk(item, reporterEmail));
  if (value instanceof Date || value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, walk(item, reporterEmail)]),
  );
}

/** A numeric column can carry a card number too, for example through a cast. */
function looksLikeCard(value: number): boolean {
  return Number.isInteger(value) && /^\d{13,19}$/.test(String(Math.abs(value)));
}

function redactString(text: string, reporterEmail: string | undefined): string {
  let output = "";
  let last = 0;
  for (const match of text.matchAll(uuidPattern)) {
    output += scrub(text.slice(last, match.index), reporterEmail) + match[0];
    last = match.index + match[0].length;
  }
  return output + scrub(text.slice(last), reporterEmail);
}

function scrub(segment: string, reporterEmail: string | undefined): string {
  return segment
    .replace(emailPattern, (email) => (email.toLowerCase() === reporterEmail ? email : EMAIL_MASK))
    .replace(cardPattern, CARD_MASK);
}
