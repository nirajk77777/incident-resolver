import { randomUUID } from "node:crypto";
import { createDb, type Db, loadConfig, tickets } from "@incident-resolver/shared";
import { inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeResolver } from "./fake-resolver";
import type { ResolverEvent, TicketResolver } from "./resolver";
import { createPortalApi } from "./server";
import type { TicketRecord } from "./store";

// Needs `docker compose up` and `pnpm db:migrate`. Run with `pnpm test:integration`.
//
// Every assertion goes over real HTTP against a listening server with the fake Resolver
// behind it, which is how portal-web and the storefront will use it.

const config = loadConfig();
let db: Db;
let app: FastifyInstance;
let baseUrl: string;
/** Every Ticket these tests opened, removed at the end so runs do not pile up in the database. */
const opened: string[] = [];

/** A Ticket as the API serves it: the row, with dates as ISO strings. */
type TicketBody = Omit<TicketRecord, "createdAt" | "closedAt"> & {
  createdAt: string;
  closedAt: string | null;
};

type ErrorBody = { error: string; message?: string };

async function post<T>(path: string, body: unknown): Promise<{ status: number; body: T }> {
  const response = await fetch(path.startsWith("http") ? path : `${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const created = (await response.json()) as T & { id?: string };
  if (created.id) opened.push(created.id);
  return { status: response.status, body: created };
}

async function get<T>(path: string): Promise<{ status: number; body: T }> {
  const response = await fetch(path.startsWith("http") ? path : `${baseUrl}${path}`);
  return { status: response.status, body: (await response.json()) as T };
}

type TimelineBody = {
  id: number;
  run: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

type SseFrame = { id: number; data: TimelineBody };

/** Frames off the timeline stream until `done` sees one, or the read times out. */
async function streamUntil(
  /** A path on the shared portal, or an absolute URL for a portal a test started itself. */
  path: string,
  done: (frame: SseFrame) => boolean,
  headers: Record<string, string> = {},
): Promise<SseFrame[]> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error(`No end frame from ${path}`)), 10_000);
  const url = path.startsWith("http") ? path : `${baseUrl}${path}`;
  const response = await fetch(url, { headers, signal: abort.signal });
  expect(response.headers.get("content-type")).toBe("text/event-stream");

  const frames: SseFrame[] = [];
  let buffer = "";
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += new TextDecoder().decode(chunk);
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        if (part.startsWith(":")) continue;
        const fields = Object.fromEntries(
          part.split("\n").map((line) => {
            const at = line.indexOf(": ");
            return [line.slice(0, at), line.slice(at + 2)];
          }),
        );
        const frame = {
          id: Number(fields.id),
          data: JSON.parse(fields.data ?? "null") as TimelineBody,
        };
        frames.push(frame);
        if (done(frame)) return frames;
      }
    }
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
  return frames;
}

const isClosed = (frame: SseFrame) =>
  frame.data.type === "status" && frame.data.payload.status === "closed";

/** A Reporter nobody else in this run shares, so assertions see only their own Tickets. */
const reporter = (name: string) => `${name}-${randomUUID()}@example.com`;

/** Opens a customer Ticket, which starts its run. */
function openTicket(reporterEmail: string, title = "Checkout failed") {
  return post<TicketBody>("/tickets", {
    source: "customer",
    reporterEmail,
    title,
    body: "My card was refused at checkout",
  });
}

/** A listening portal on a free port, and where to reach it. */
async function startApi(resolver: TicketResolver): Promise<[FastifyInstance, string]> {
  const started = createPortalApi({ db, config, resolver });
  await started.listen({ port: 0, host: "127.0.0.1" });
  const address = started.server.address();
  if (address === null || typeof address === "string") throw new Error("No port");
  return [started, `http://127.0.0.1:${address.port}`];
}

beforeAll(async () => {
  db = createDb(config.infra.databaseUrl);
  // A short pause between events so runs overlap in time and the stream is genuinely live.
  [app, baseUrl] = await startApi(createFakeResolver({ stepDelayMs: 10 }));
});

afterAll(async () => {
  await app.close();
  if (opened.length > 0) await db.delete(tickets).where(inArray(tickets.id, opened));
  await db.$client.end();
});

describe("creating a Ticket", () => {
  it("accepts a customer Ticket with its Reporter, trace id, title and body", async () => {
    const created = await post<TicketBody>("/tickets", {
      source: "customer",
      reporterEmail: "ava.chen@example.com",
      traceId: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
      title: "Checkout failed",
      body: "My card was refused at checkout",
    });

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      source: "customer",
      reporterEmail: "ava.chen@example.com",
      traceId: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
      title: "Checkout failed",
      status: "new",
      outcome: null,
      reply: null,
    });
    expect(created.body.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("refuses a customer Ticket with no Reporter email", async () => {
    const created = await post<ErrorBody>("/tickets", {
      source: "customer",
      title: "Checkout failed",
      body: "My card was refused",
    });
    expect(created.status).toBe(400);
    expect(created.body.message).toMatch(/reporterEmail/);
  });

  it("accepts a tester Ticket, which has no Reporter email", async () => {
    const created = await post<TicketBody>("/tickets", {
      source: "tester",
      title: "Cart total wrong",
      body: "Removing an item leaves the badge stale",
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ source: "tester", reporterEmail: null });
  });

  it("serves the Ticket back by id, and lists it with the newest Tickets first", async () => {
    const created = await post<TicketBody>("/tickets", {
      source: "sentinel",
      title: "Error rate on /checkout",
      body: "12% of requests failing",
    });

    const fetched = await get<TicketBody>(`/tickets/${created.body.id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.id).toBe(created.body.id);

    const listed = await get<{ tickets: TicketBody[] }>("/tickets");
    expect(listed.status).toBe(200);
    expect(listed.body.tickets.map((ticket) => ticket.id)).toContain(created.body.id);
    const times = listed.body.tickets.map((ticket) => Date.parse(ticket.createdAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it("is a 404 for a Ticket that does not exist", async () => {
    const missing = await get<ErrorBody>("/tickets/00000000-0000-4000-8000-0000000000ff");
    expect(missing.status).toBe(404);
  });
});

describe("the live timeline", () => {
  it("streams the run: the lifecycle moves, the work, the Verdict, and the close", async () => {
    const created = await openTicket(reporter("timeline"));
    const frames = await streamUntil(`/tickets/${created.body.id}/events`, isClosed);

    expect(frames.map((frame) => frame.data.type)).toEqual([
      "subagent_start",
      "status",
      "subagent_end",
      "subagent_start",
      "status",
      "tool_call",
      "tool_result",
      "subagent_end",
      "message",
      "verdict",
      "status",
    ]);
    expect(
      frames.filter((f) => f.data.type === "status").map((frame) => frame.data.payload.status),
    ).toEqual(["triaging", "investigating", "closed"]);
    expect(frames.every((frame) => frame.data.run === 1)).toBe(true);
    expect(frames.map((frame) => frame.id)).toEqual(
      [...frames.map((frame) => frame.id)].sort((a, b) => a - b),
    );
  });

  it("closes the Ticket with exactly one Outcome and one Reply", async () => {
    const created = await openTicket(reporter("outcome"));
    await streamUntil(`/tickets/${created.body.id}/events`, isClosed);

    const closed = await get<TicketBody>(`/tickets/${created.body.id}`);
    expect(closed.body).toMatchObject({
      status: "closed",
      outcome: "answered",
      category: "user_error",
    });
    expect(closed.body.reply).toContain("declined");
    expect(closed.body.rootCause).not.toBeNull();
    expect(closed.body.closedAt).not.toBeNull();
  });
});

describe("catching a timeline up", () => {
  it("replays only what a reloaded page missed, from the last event id it saw", async () => {
    const created = await openTicket(reporter("catchup"));
    const path = `/tickets/${created.body.id}/events`;
    const whole = await streamUntil(path, isClosed);
    const missedFrom = whole[4]?.id ?? 0;

    const header = await streamUntil(path, isClosed, { "last-event-id": String(missedFrom) });
    expect(header.map((frame) => frame.id)).toEqual(whole.slice(5).map((frame) => frame.id));

    const query = await streamUntil(`${path}?lastEventId=${missedFrom}`, isClosed);
    expect(query.map((frame) => frame.id)).toEqual(header.map((frame) => frame.id));
  });

  it("replays the whole timeline when the client has seen nothing", async () => {
    const created = await openTicket(reporter("replay"));
    const path = `/tickets/${created.body.id}/events`;
    const whole = await streamUntil(path, isClosed);

    const again = await streamUntil(path, isClosed, { "last-event-id": "not-a-number" });
    expect(again.map((frame) => frame.id)).toEqual(whole.map((frame) => frame.id));
  });
});

describe("Tickets running at once", () => {
  it("runs two Tickets on independent timelines that overlap in time", async () => {
    const [first, second] = await Promise.all([
      openTicket(reporter("concurrent-one"), "Checkout failed"),
      openTicket(reporter("concurrent-two"), "Cart total wrong"),
    ]);

    const [firstFrames, secondFrames] = await Promise.all([
      streamUntil(`/tickets/${first.body.id}/events`, isClosed),
      streamUntil(`/tickets/${second.body.id}/events`, isClosed),
    ]);

    expect(firstFrames).toHaveLength(11);
    expect(secondFrames).toHaveLength(11);
    // Each stream carries only its own Ticket's entries.
    expect(new Set(firstFrames.map((frame) => frame.id))).not.toEqual(
      new Set(secondFrames.map((frame) => frame.id)),
    );

    const span = (frames: SseFrame[]) => ({
      from: new Date(frames[0]?.data.createdAt ?? 0).getTime(),
      to: new Date(frames.at(-1)?.data.createdAt ?? 0).getTime(),
    });
    const one = span(firstFrames);
    const two = span(secondFrames);
    expect(one.from).toBeLessThanOrEqual(two.to);
    expect(two.from).toBeLessThanOrEqual(one.to);

    for (const id of [first.body.id, second.body.id]) {
      const closed = await get<TicketBody>(`/tickets/${id}`);
      expect(closed.body.status).toBe("closed");
      expect(closed.body.outcome).toBe("answered");
    }
  });
});

describe("what a Reporter can read", () => {
  it("returns that Reporter's Tickets and Replies, and nobody else's", async () => {
    const mineEmail = reporter("storefront");
    const mine = await openTicket(mineEmail, "Checkout failed");
    await openTicket(reporter("someone-else"), "Discount applied twice");
    await streamUntil(`/tickets/${mine.body.id}/events`, isClosed);

    const read = await get<{ tickets: Array<{ id: string; title: string; reply: string | null }> }>(
      `/reporters/${encodeURIComponent(mineEmail)}/tickets`,
    );

    expect(read.status).toBe(200);
    expect(read.body.tickets).toHaveLength(1);
    expect(read.body.tickets[0]?.id).toBe(mine.body.id);
    expect(read.body.tickets[0]?.reply).toContain("declined");
  });

  it("refuses an address that is not an email", async () => {
    const read = await get<ErrorBody>("/reporters/not-an-email/tickets");
    expect(read.status).toBe(400);
  });
});

describe("a run that fails", () => {
  /** Emits one event and then breaks, the way a model call or an MCP server can. */
  const brokenResolver: TicketResolver = {
    name: "broken",
    async *resolve(): AsyncIterable<ResolverEvent> {
      yield { type: "subagent_start", name: "triage" };
      throw new Error("the model went away");
    },
  };

  it("leaves the Ticket closed and escalated, not stuck mid-investigation", async () => {
    const [broken, brokenUrl] = await startApi(brokenResolver);
    try {
      const created = await post<TicketBody>(`${brokenUrl}/tickets`, {
        source: "tester",
        title: "Cart total wrong",
        body: "Stale badge",
      });

      const frames = await streamUntil(`${brokenUrl}/tickets/${created.body.id}/events`, isClosed);
      const failure = frames.find((frame) => frame.data.type === "message");
      expect(failure?.data.payload).toMatchObject({ reason: "agent_error" });

      const closed = await get<TicketBody>(`${brokenUrl}/tickets/${created.body.id}`);
      expect(closed.body.status).toBe("closed");
      expect(closed.body.outcome).toBe("escalated");
      expect(closed.body.reply).toContain("member of the team");
    } finally {
      await broken.close();
    }
  });
});

describe("a run that waits for a Reviewer", () => {
  /**
   * The approval gate itself belongs to a later issue, but a Resolver that interrupts is
   * what drives the two lifecycle statuses either side of it, so the portal has to move
   * through them from the stream alone.
   */
  const interruptingResolver: TicketResolver = {
    name: "interrupting",
    async *resolve(): AsyncIterable<ResolverEvent> {
      yield { type: "subagent_start", name: "data-investigator" };
      yield {
        type: "interrupt",
        action: "propose_data_fix",
        proposal: { kind: "data_fix", table: "shoplite.cart_totals" },
      };
      yield { type: "message", text: "Applying the approved fix" };
      yield {
        type: "verdict",
        verdict: {
          outcome: "data_fixed",
          category: "data_issue",
          confidence: 0.9,
          rootCause: "The cart total was never updated when the item was removed",
          evidence: [],
          reply: "We have corrected your cart total.",
        },
      };
    },
  };

  it("waits at awaiting approval, then acts, then closes", async () => {
    const [portal, portalUrl] = await startApi(interruptingResolver);
    try {
      const created = await post<TicketBody>(`${portalUrl}/tickets`, {
        source: "tester",
        title: "Cart total wrong",
        body: "Removing an item leaves the badge stale",
      });

      const frames = await streamUntil(`${portalUrl}/tickets/${created.body.id}/events`, isClosed);

      expect(
        frames.filter((f) => f.data.type === "status").map((frame) => frame.data.payload.status),
      ).toEqual(["investigating", "awaiting_approval", "acting", "closed"]);

      const closed = await get<TicketBody>(`${portalUrl}/tickets/${created.body.id}`);
      expect(closed.body.outcome).toBe("data_fixed");
    } finally {
      await portal.close();
    }
  });
});
