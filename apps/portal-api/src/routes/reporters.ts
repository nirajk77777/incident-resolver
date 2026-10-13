import { formatIssues } from "@incident-resolver/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PortalStore } from "../db/store";

const reporterSchema = z.object({ email: z.email() });

/** What the storefront's "My tickets" page reads: one Reporter's Tickets and their Replies. */
export async function reporterRoutes(
  app: FastifyInstance,
  { store }: { store: PortalStore },
): Promise<void> {
  app.get("/reporters/:email/tickets", async (request, reply) => {
    const params = reporterSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Bad Request", message: formatIssues(params.error) });
    }
    const found = await store.ticketsForReporter(params.data.email);
    return {
      tickets: found.map((ticket) => ({
        id: ticket.id,
        title: ticket.title,
        body: ticket.body,
        traceId: ticket.traceId,
        status: ticket.status,
        outcome: ticket.outcome,
        reply: ticket.reply,
        createdAt: ticket.createdAt,
        closedAt: ticket.closedAt,
      })),
    };
  });
}
