import { randomUUID } from "node:crypto";
import { createDb, type Db, loadConfig, tickets } from "@incident-resolver/shared";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FAKE_VERDICT } from "./fake-resolver";
import { createPortalStore, type PortalStore } from "./store";

// Needs `docker compose up` and `pnpm db:migrate`. Run with `pnpm test:integration`.

let db: Db;
let store: PortalStore;
/** Every Ticket these tests opened, removed at the end so runs do not pile up in the database. */
const opened: string[] = [];

const tester = { source: "tester" as const, title: "Cart total wrong", body: "Badge stays stale" };

/** A Ticket that will be cleaned up with the rest. */
async function openTicket() {
  const { ticket } = await store.createTicket(tester);
  opened.push(ticket.id);
  return ticket;
}

beforeAll(() => {
  db = createDb(loadConfig().infra.databaseUrl);
  store = createPortalStore(db);
});

afterAll(async () => {
  if (opened.length > 0) await db.delete(tickets).where(inArray(tickets.id, opened));
  await db.$client.end();
});

describe("the portal store", () => {
  it("keeps at most one open Ticket per Sentinel fingerprint", async () => {
    const fingerprint = `/customers/:customerId/checkout:http_500:${randomUUID()}`;
    const detection = {
      source: "sentinel" as const,
      title: "Checkout is failing",
      body: "Half of the requests are 500s",
      fingerprint,
    };

    const first = await store.createTicket(detection);
    opened.push(first.ticket.id);
    expect(first.created).toBe(true);
    expect(first.ticket.fingerprint).toBe(fingerprint);

    // The same spike, seen again on the next poll: the Ticket already open, not another one.
    const second = await store.createTicket({ ...detection, title: "Checkout is still failing" });
    expect(second.created).toBe(false);
    expect(second.ticket.id).toBe(first.ticket.id);
    expect(second.ticket.title).toBe("Checkout is failing");

    // Two detections landing at once: the partial unique index refuses the second insert,
    // and the store answers with the Ticket that won rather than throwing.
    const together = await Promise.all([
      store.createTicket({ ...detection, fingerprint: `${fingerprint}:race` }),
      store.createTicket({ ...detection, fingerprint: `${fingerprint}:race` }),
    ]);
    for (const result of together) opened.push(result.ticket.id);
    expect(new Set(together.map((result) => result.ticket.id)).size).toBe(1);
    expect(together.filter((result) => result.created)).toHaveLength(1);

    // Once the Ticket is closed the problem may be filed again, which is what should happen
    // if the same route starts failing next week.
    await store.closeTicket(
      first.ticket.id,
      { ...FAKE_VERDICT, outcome: "escalated" },
      "Nobody has picked this up yet.",
    );
    const afterClose = await store.createTicket(detection);
    opened.push(afterClose.ticket.id);
    expect(afterClose.created).toBe(true);
    expect(afterClose.ticket.id).not.toBe(first.ticket.id);
  });

  it("is on run 0 until a run writes to it, and on the highest run afterwards", async () => {
    const ticket = await openTicket();
    expect(await store.latestRun(ticket.id)).toBe(0);

    await store.appendEvent({
      ticketId: ticket.id,
      run: 1,
      type: "message",
      payload: { text: "Looking into it" },
    });
    expect(await store.latestRun(ticket.id)).toBe(1);

    await store.appendEvent({
      ticketId: ticket.id,
      run: 2,
      type: "message",
      payload: { text: "And again" },
    });
    expect(await store.latestRun(ticket.id)).toBe(2);
  });

  it("serves a timeline in order, and only what comes after the entry a client saw", async () => {
    const ticket = await openTicket();
    const written = [];
    for (const text of ["one", "two", "three"]) {
      written.push(
        await store.appendEvent({
          ticketId: ticket.id,
          run: 1,
          type: "message",
          payload: { text },
        }),
      );
    }

    expect((await store.eventsAfter(ticket.id, 0)).map((entry) => entry.id)).toEqual(
      written.map((entry) => entry.id),
    );
    expect(
      (await store.eventsAfter(ticket.id, written[0]?.id ?? 0)).map((e) => e.payload.text),
    ).toEqual(["two", "three"]);
  });

  it("closes a Ticket on its Verdict, with the Outcome, the Reply, and the agent as resolver", async () => {
    const ticket = await openTicket();
    const closed = await store.closeTicket(ticket.id, FAKE_VERDICT, "Answered from the logs.");

    expect(closed.status).toBe("closed");
    expect(closed.outcome).toBe(FAKE_VERDICT.outcome);
    expect(closed.reply).toBe(FAKE_VERDICT.reply);
    expect(closed.resolution).toBe("Answered from the logs.");
    expect(closed.resolvedBy).toBe("agent");
    expect(closed.closedAt).toBeInstanceOf(Date);
  });

  it("leaves an escalated Ticket resolved by nobody, which is what makes it a Reviewer's", async () => {
    const ticket = await openTicket();
    const escalated = await store.closeTicket(
      ticket.id,
      { ...FAKE_VERDICT, outcome: "escalated" },
      "Handed to a human.",
    );
    expect(escalated.resolvedBy).toBeNull();
  });

  it("finishes an escalated Ticket on what a Reviewer wrote, marked resolved by a human", async () => {
    const ticket = await openTicket();
    await store.closeTicket(ticket.id, { ...FAKE_VERDICT, outcome: "escalated" }, "Handed over.");

    const resolved = await store.resolveManually(ticket.id, {
      rootCause: "The gateway timed out.",
      resolution: "Deleted the orphaned order row.",
      reply: "The stuck order is cleared, please try again.",
      author: "Priya",
    });

    expect(resolved.status).toBe("closed");
    // The Outcome stays what it was: escalation is how this Ticket ended, and a person
    // finishing it does not change that it needed one.
    expect(resolved.outcome).toBe("escalated");
    expect(resolved.reply).toBe("The stuck order is cleared, please try again.");
    expect(resolved.rootCause).toBe("The gateway timed out.");
    expect(resolved.resolution).toBe("Deleted the orphaned order row.");
    expect(resolved.resolvedBy).toBe("human");
  });

  it("reopens a closed Ticket for another run, clearing what the last one concluded", async () => {
    const ticket = await openTicket();
    await store.closeTicket(ticket.id, FAKE_VERDICT, "Answered from the logs.");

    const reopened = await store.reopen(ticket.id);
    expect(reopened).toMatchObject({
      status: "new",
      outcome: null,
      reply: null,
      category: null,
      confidence: null,
      rootCause: null,
      resolution: null,
      resolvedBy: null,
      closedAt: null,
    });
  });

  it("refuses to close a Ticket without an Outcome and a Reply, whatever the caller does", async () => {
    const ticket = await openTicket();
    const failure = await store.setStatus(ticket.id, "closed").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as Error).cause)).toContain("tickets_closed_carries_outcome_and_reply");
  });
});
