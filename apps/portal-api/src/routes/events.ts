import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireTicket } from "../http/ticket-param";
import type { PortalServices } from "../server";
import {
  formatSseFrame,
  lastEventIdOf,
  SSE_HEADERS,
  SSE_KEEP_ALIVE,
  SSE_KEEP_ALIVE_MS,
} from "../timeline/sse";
import type { TimelineEntry } from "../timeline/timeline";

const eventsQuerySchema = z.object({ lastEventId: z.string().optional() });

export async function eventRoutes(
  app: FastifyInstance,
  { store, bus, openStreams }: PortalServices,
): Promise<void> {
  /**
   * The live timeline. A client that reconnects sends the id of the last entry it saw, in
   * the `Last-Event-ID` header or the `lastEventId` query, and gets everything after it
   * before the stream goes live. The connection stays open across the close of the Ticket,
   * so a re-run keeps streaming to the same watcher.
   */
  app.get("/tickets/:id/events", async (request, reply) => {
    const ticket = await requireTicket(store, request, reply);
    if (!ticket) return;

    const query = eventsQuerySchema.safeParse(request.query);
    let cursor = lastEventIdOf(
      request.headers["last-event-id"],
      query.success ? query.data.lastEventId : undefined,
    );

    reply.hijack();
    const stream = reply.raw;
    stream.writeHead(200, SSE_HEADERS);

    const send = (entry: TimelineEntry) => {
      if (entry.id <= cursor) return;
      cursor = entry.id;
      stream.write(formatSseFrame(entry));
    };

    // Subscribing before the catch-up read means an entry written during the read is held
    // rather than lost; `send` then drops the ones the read already covered.
    const live: TimelineEntry[] = [];
    let replaying = true;
    const unsubscribe = bus.subscribe(ticket.id, (entry) => {
      if (replaying) live.push(entry);
      else send(entry);
    });

    const keepAlive = setInterval(() => stream.write(SSE_KEEP_ALIVE), SSE_KEEP_ALIVE_MS);
    const release = () => {
      clearInterval(keepAlive);
      unsubscribe();
      openStreams.delete(close);
    };
    const close = () => {
      release();
      stream.end();
    };
    openStreams.add(close);
    // The client hung up: let go of the subscription, but leave the socket to Node.
    request.raw.on("close", release);

    try {
      for (const entry of await store.eventsAfter(ticket.id, cursor)) send(entry);
      replaying = false;
      for (const entry of live) send(entry);
    } catch (error) {
      app.log.error({ ticketId: ticket.id, err: error }, "Could not catch a timeline up");
      close();
    }
  });
}
