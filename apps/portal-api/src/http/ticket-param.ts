import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { PortalStore, TicketRecord } from "../db/store";

const ticketIdSchema = z.object({ id: z.uuid() });

/**
 * Resolves the `:id` path parameter to a Ticket, or sends a 404 and returns undefined. An id
 * that is not a uuid is answered the same as one that names no Ticket.
 */
export async function requireTicket(
  store: PortalStore,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<TicketRecord | undefined> {
  const params = ticketIdSchema.safeParse(request.params);
  const ticket = params.success ? await store.getTicket(params.data.id) : undefined;
  if (!ticket) {
    await reply.code(404).send({ error: "Not Found" });
    return undefined;
  }
  return ticket;
}
