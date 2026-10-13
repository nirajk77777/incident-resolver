import { formatIssues, manualResolutionSchema, newTicketSchema } from "@incident-resolver/shared";
import type { FastifyInstance } from "fastify";
import type { PortalStore } from "../db/store";
import { requireTicket } from "../http/ticket-param";
import type { TicketRunner } from "../tickets/runner";

/**
 * Tickets in from customers, testers and Sentinel, and the two ways a person moves one on
 * after its run: resolving an escalated Ticket by hand, and running a closed one again.
 */
export async function ticketRoutes(
  app: FastifyInstance,
  { store, runner }: { store: PortalStore; runner: TicketRunner },
): Promise<void> {
  /**
   * Creating a Ticket starts its run, so a client can be watching the stream before the first
   * entry lands and still see everything: the stream always replays what it missed.
   */
  app.post("/tickets", async (request, reply) => {
    const parsed = newTicketSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Bad Request", message: formatIssues(parsed.error) });
    }
    // A Sentinel detection that matches a fingerprint already open joins that Ticket: the
    // same spike seen twice is one problem, and answering 200 tells Sentinel which one.
    const { ticket, created } = await store.createTicket(parsed.data);
    if (!created) return reply.code(200).send(ticket);
    runner.start(ticket);
    return reply.code(201).send(ticket);
  });

  app.get("/tickets", async () => ({ tickets: await store.listTickets() }));

  app.get("/tickets/:id", async (request, reply) => {
    return requireTicket(store, request, reply);
  });

  /**
   * How a Reviewer finishes an escalated Ticket: the root cause, what fixed it, and the Reply
   * the Reporter reads in place of the holding message. Submitting it writes the Incident, so
   * the knowledge base learns from the Tickets the Resolver could not finish as well as from
   * the ones it could.
   */
  app.post("/tickets/:id/resolution", async (request, reply) => {
    const ticket = await requireTicket(store, request, reply);
    if (!ticket) return;

    const written = manualResolutionSchema.safeParse(request.body);
    if (!written.success) {
      return reply.code(400).send({ error: "Bad Request", message: formatIssues(written.error) });
    }
    const result = await runner.resolve(ticket, written.data);
    if (!result.ok) {
      return reply.code(result.status).send({ error: "Conflict", message: result.message });
    }
    return result.ticket;
  });

  /**
   * Runs a closed Ticket again. The new run gets the next run number and its own thread, so
   * nothing it does can reach the checkpoint the last one left; the Timeline keeps both,
   * labelled by run. This answers as soon as the Ticket is reopened, and what the run then
   * does arrives on the timeline like everything else.
   */
  app.post("/tickets/:id/rerun", async (request, reply) => {
    const ticket = await requireTicket(store, request, reply);
    if (!ticket) return;

    const result = await runner.rerun(ticket);
    if (!result.ok) {
      return reply.code(result.status).send({ error: "Conflict", message: result.message });
    }
    return reply.code(202).send(result.ticket);
  });
}
