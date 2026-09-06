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
  const ticket = await store.createTicket(tester);
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
  it("numbers a Ticket's first run 1 and every re-run after it", async () => {
    const ticket = await openTicket();
    expect(await store.nextRun(ticket.id)).toBe(1);

    await store.appendEvent({
      ticketId: ticket.id,
      run: 1,
      type: "message",
      payload: { text: "Looking into it" },
    });
    expect(await store.nextRun(ticket.id)).toBe(2);
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

  it("closes a Ticket on its Verdict, with the Outcome and the Reply", async () => {
    const ticket = await openTicket();
    const closed = await store.closeTicket(ticket.id, FAKE_VERDICT);

    expect(closed.status).toBe("closed");
    expect(closed.outcome).toBe(FAKE_VERDICT.outcome);
    expect(closed.reply).toBe(FAKE_VERDICT.reply);
    expect(closed.closedAt).toBeInstanceOf(Date);
  });

  it("refuses to close a Ticket without an Outcome and a Reply, whatever the caller does", async () => {
    const ticket = await openTicket();
    const failure = await store.setStatus(ticket.id, "closed").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String((failure as Error).cause)).toContain("tickets_closed_carries_outcome_and_reply");
  });
});
