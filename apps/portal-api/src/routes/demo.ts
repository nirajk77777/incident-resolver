import { messageOf } from "@incident-resolver/shared";
import type { FastifyInstance } from "fastify";
import type { PortalServices } from "../server";

/**
 * The two buttons on the portal's hidden Demo panel, and the only routes here that exist
 * for a rehearsal rather than for the product.
 */
export async function demoRoutes(
  app: FastifyInstance,
  { demo, runner }: PortalServices,
): Promise<void> {
  /**
   * Traffic is relayed to ShopLite, status and all, so a burst already running comes back
   * worded as ShopLite worded it.
   */
  app.post("/demo/simulate-traffic", async (request, reply) => {
    try {
      const answer = await demo.simulateTraffic(request.body ?? {});
      return reply.code(answer.status).send(answer.body);
    } catch (error) {
      app.log.error({ err: error }, "Could not reach ShopLite to simulate traffic");
      return reply.code(502).send({ error: "Bad Gateway", message: messageOf(error) });
    }
  });

  /**
   * Puts everything back: ShopLite reseeded, Tickets and their timelines, approvals,
   * checkpoints and Workspaces cleared, Incidents kept. It refuses while a Ticket is still
   * running, since deleting a Ticket out from under its own run leaves the run writing to
   * something that is not there.
   */
  app.post("/demo/reset", async (_request, reply) => {
    const running = runner.busy();
    if (running > 0) {
      return reply.code(409).send({
        error: "Conflict",
        message: `${running} ${running === 1 ? "Ticket is" : "Tickets are"} still running. Wait for them to close, then reset.`,
      });
    }
    const report = await demo.reset();
    return reply.code(report.ok ? 200 : 500).send(report);
  });
}
