import { z } from "zod";
import { ticketSources } from "./db/schema";

export { type TicketSource, ticketSources } from "./db/schema";

/** What a Reporter, a tester, or Sentinel says when opening a Ticket. */
const ticketFields = {
  source: z.enum(ticketSources),
  /** The Reporter's email for customer Tickets: scopes database queries and redaction. */
  reporterEmail: z.email().optional(),
  /** The ShopLite trace id from the storefront's error toast, when the Reporter had one. */
  traceId: z.string().min(1).optional(),
  title: z.string().min(1),
  body: z.string().min(1),
  /**
   * Sentinel's key for the problem it saw — a route and an error type — rather than for
   * this Ticket. The portal keeps at most one open Ticket per fingerprint, so a second
   * detection of the same spike finds the first still open instead of filing another.
   */
  fingerprint: z.string().min(1).optional(),
};

const hasNoStrayFingerprint = (ticket: { source: string; fingerprint?: string | undefined }) =>
  ticket.source === "sentinel" || ticket.fingerprint === undefined;

const fingerprintRule = {
  message: "Only a Sentinel Ticket carries a fingerprint",
  path: ["fingerprint"],
};

const hasReporterEmail = (ticket: { source: string; reporterEmail?: string | undefined }) =>
  ticket.source !== "customer" || ticket.reporterEmail !== undefined;

const reporterEmailRule = {
  message: "A customer Ticket needs the reporter's email",
  path: ["reporterEmail"],
};

/** A Ticket as the portal's create endpoint takes it in, before it has an id. */
export const newTicketSchema = z
  .object(ticketFields)
  .refine(hasReporterEmail, reporterEmailRule)
  .refine(hasNoStrayFingerprint, fingerprintRule);

export type NewTicket = z.infer<typeof newTicketSchema>;

/**
 * A request for investigation, whatever its Source. This is what the Resolver takes in,
 * from the CLI today and from the portal's tickets table later.
 */
export const ticketSchema = z
  .object({ id: z.uuid(), ...ticketFields })
  .refine(hasReporterEmail, reporterEmailRule)
  .refine(hasNoStrayFingerprint, fingerprintRule);

export type Ticket = z.infer<typeof ticketSchema>;
