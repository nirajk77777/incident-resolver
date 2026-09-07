import { joinUrl, type NewTicket } from "@incident-resolver/shared";

/**
 * How Sentinel opens a Ticket: over the portal's own HTTP surface, the same one the
 * storefront and the tester form use. Sentinel is not privileged, and it holds no database
 * connection: the portal owns Tickets and the portal decides what happens to this one.
 */

/** What the portal answered: the Ticket, and whether this detection is what opened it. */
export type PortalAnswer = {
  id: string;
  title: string;
  /** False when the fingerprint was already on an open Ticket, which the portal says with a 200. */
  created: boolean;
};

export type PortalClient = {
  openTicket(ticket: NewTicket): Promise<PortalAnswer>;
};

export function createPortalClient(baseUrl: string): PortalClient {
  return {
    async openTicket(ticket) {
      const response = await fetch(joinUrl(baseUrl, "/tickets"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(ticket),
      });
      const body = (await response.json().catch(() => null)) as {
        id?: string;
        title?: string;
        message?: string;
        error?: string;
      } | null;
      if (!response.ok || !body?.id) {
        const said = body?.message ?? body?.error ?? "no reason given";
        throw new Error(`The portal refused the Ticket: ${response.status} ${said}`);
      }
      // 201 is a Ticket this detection opened; 200 is the one already open on its fingerprint.
      return { id: body.id, title: body.title ?? ticket.title, created: response.status === 201 };
    },
  };
}
