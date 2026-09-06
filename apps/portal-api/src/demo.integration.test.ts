import type { WorkspaceStore } from "@incident-resolver/agents";
import {
  createDb,
  type Db,
  incidents,
  loadConfig,
  ticketEvents,
  tickets,
} from "@incident-resolver/shared";
import { count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDemo } from "./demo";

// Needs `docker compose up` and `pnpm db:migrate`. Run with `pnpm test:integration`.
//
// A reset clears the portal, which is the whole point of it, so this file empties the same
// tables `pnpm demo:reset` does. ShopLite's own reseed and the Workspace store are injected:
// one is ShopLite's to test, and the other would take a real clone off the disk.

const config = loadConfig();
let db: Db;

/** A Workspace store that only remembers being asked, so no real clone is removed. */
function fakeWorkspaces() {
  const store = {
    removals: 0,
    for: () => {
      throw new Error("A reset never asks for one Ticket's Workspace");
    },
    async removeAll() {
      store.removals += 1;
    },
  };
  return store satisfies WorkspaceStore & { removals: number };
}

/** A Sentinel Ticket with an entry on its timeline, so a reset has something to clear. */
async function openTicketWithTimeline() {
  const [ticket] = await db
    .insert(tickets)
    .values({ source: "sentinel", title: "Checkout is failing", body: "500s for everyone" })
    .returning();
  if (!ticket) throw new Error("Insert returned no Ticket");
  await db.insert(ticketEvents).values({
    ticketId: ticket.id,
    run: 1,
    type: "message",
    payload: { text: "Looking into it" },
  });
  return ticket;
}

const incidentCount = async () =>
  (await db.select({ kept: count() }).from(incidents))[0]?.kept ?? 0;

beforeAll(() => {
  db = createDb(config.infra.databaseUrl);
});

afterAll(async () => {
  await db.$client.end();
});

describe("the demo reset", () => {
  it("clears what a rehearsal produced, keeps the knowledge base, and says what it did", async () => {
    const ticket = await openTicketWithTimeline();
    const kept = await incidentCount();

    const workspaces = fakeWorkspaces();
    const resetShoplite = vi.fn(async () => {});
    const report = await createDemo({ db, config, workspaces, resetShoplite }).reset();

    expect(report.ok).toBe(true);
    expect(report.steps.map((step) => step.step)).toEqual([
      "ShopLite data",
      "Tickets, their timelines and approvals",
      "Run checkpoints",
      "Workspaces",
      "Incidents",
    ]);
    expect(resetShoplite).toHaveBeenCalledOnce();
    expect(workspaces.removals).toBe(1);

    // The Ticket is gone, and its timeline went with it rather than being cleared
    // separately: `ticket_events` cascades from `tickets`, and so do approvals.
    expect(await db.select().from(tickets).where(eq(tickets.id, ticket.id))).toEqual([]);
    expect(
      await db.select().from(ticketEvents).where(eq(ticketEvents.ticketId, ticket.id)),
    ).toEqual([]);

    // Incidents are the knowledge base. A rehearsal that wiped them would be rehearsing a
    // different system, so a reset counts them and leaves them where they are.
    expect(await incidentCount()).toBe(kept);
    expect(report.steps.at(-1)?.detail).toContain(`${kept} kept`);
  });

  it("reports the step that failed rather than giving up on the rest", async () => {
    const ticket = await openTicketWithTimeline();
    const workspaces = fakeWorkspaces();

    const report = await createDemo({
      db,
      config,
      workspaces,
      resetShoplite: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:4000");
      },
    }).reset();

    expect(report.ok).toBe(false);
    expect(report.steps[0]).toEqual({
      step: "ShopLite data",
      done: false,
      detail: "connect ECONNREFUSED 127.0.0.1:4000",
    });
    // ShopLite being down is not a reason to leave the portal full of last run's Tickets.
    expect(report.steps.slice(1).every((step) => step.done)).toBe(true);
    expect(await db.select().from(tickets).where(eq(tickets.id, ticket.id))).toEqual([]);
  });
});
