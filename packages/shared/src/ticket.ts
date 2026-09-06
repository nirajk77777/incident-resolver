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
};

const hasReporterEmail = (ticket: { source: string; reporterEmail?: string | undefined }) =>
  ticket.source !== "customer" || ticket.reporterEmail !== undefined;

const reporterEmailRule = {
  message: "A customer Ticket needs the reporter's email",
  path: ["reporterEmail"],
};

/** A Ticket as the portal's create endpoint takes it in, before it has an id. */
export const newTicketSchema = z.object(ticketFields).refine(hasReporterEmail, reporterEmailRule);

export type NewTicket = z.infer<typeof newTicketSchema>;

/**
 * A request for investigation, whatever its Source. This is what the Resolver takes in,
 * from the CLI today and from the portal's tickets table later.
 */
export const ticketSchema = z
  .object({ id: z.uuid(), ...ticketFields })
  .refine(hasReporterEmail, reporterEmailRule);

export type Ticket = z.infer<typeof ticketSchema>;
