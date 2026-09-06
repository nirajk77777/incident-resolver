import { z } from "zod";

/** Where a Ticket came from, see CONTEXT.md. */
export const ticketSources = ["customer", "tester", "sentinel"] as const;
export type TicketSource = (typeof ticketSources)[number];

/**
 * A request for investigation, whatever its Source. This is what the Resolver takes in,
 * from the CLI today and from the portal's tickets table later.
 */
export const ticketSchema = z
  .object({
    id: z.uuid(),
    source: z.enum(ticketSources),
    /** The Reporter's email for customer Tickets: scopes database queries and redaction. */
    reporterEmail: z.email().optional(),
    /** The ShopLite trace id from the storefront's error toast, when the Reporter had one. */
    traceId: z.string().min(1).optional(),
    title: z.string().min(1),
    body: z.string().min(1),
  })
  .refine((ticket) => ticket.source !== "customer" || ticket.reporterEmail !== undefined, {
    message: "A customer Ticket needs the reporter's email",
    path: ["reporterEmail"],
  });

export type Ticket = z.infer<typeof ticketSchema>;
