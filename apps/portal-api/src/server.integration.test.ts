import { randomUUID } from "node:crypto";
import { createDb, type Db, loadConfig, tickets } from "@incident-resolver/shared";
import { inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeResolver, FAKE_VERDICT } from "./fake-resolver";
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

const isWaiting = (frame: SseFrame) =>
  frame.data.type === "status" && frame.data.payload.status === "awaiting_approval";

/** An approval as `/tickets/:id/approvals` serves it. */
type ApprovalBody = {
  id: string;
  action: string;
  allowedDecisions: string[];
  proposal: Record<string, unknown>;
  preview: Record<string, unknown> | null;
  decision: string | null;
  reason: string | null;
  result: Record<string, unknown> | null;
  executedAt: string | null;
};

/** A canned Resolver that never proposes anything, so it is never resumed. */
function neverResumed(): AsyncIterable<ResolverEvent> {
  throw new Error("This Resolver proposes nothing, so it is never resumed");
}

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

  it("joins a Sentinel detection to the Ticket already open on its fingerprint", async () => {
    const detection = {
      source: "sentinel" as const,
      title: "Checkout is failing for everyone",
      body: "97% of POST /customers/:customerId/checkout returned 500 over the last minute",
      fingerprint: `/customers/:customerId/checkout:http_500:${randomUUID()}`,
    };

    const first = await post<TicketBody>("/tickets", detection);
    expect(first.status).toBe(201);
    expect(first.body.fingerprint).toBe(detection.fingerprint);

    // The next poll sees the same spike. One problem, one Ticket, and a 200 rather than a
    // 201 so Sentinel can tell that it joined instead of opening.
    const again = await post<TicketBody>("/tickets", { ...detection, title: "Still failing" });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);

    const listed = await get<{ tickets: TicketBody[] }>("/tickets");
    const matching = listed.body.tickets.filter(
      (ticket) => ticket.fingerprint === detection.fingerprint,
    );
    expect(matching).toHaveLength(1);
  });

  it("refuses a fingerprint on a Ticket that is not Sentinel's", async () => {
    const refused = await post<ErrorBody>("/tickets", {
      source: "tester",
      title: "Cart total wrong",
      body: "Removing an item leaves the badge stale",
      fingerprint: "/cart:http_500",
    });

    expect(refused.status).toBe(400);
    expect(refused.body.message).toContain("fingerprint");
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
      "tool_call",
      "tool_result",
      "subagent_end",
      "message",
      "verdict",
      "status",
    ]);
    // The Investigator's first query was unscoped, and the guard turned it away: a customer
    // Ticket's timeline says so rather than showing a call that answered nothing.
    expect(
      frames.filter((f) => f.data.type === "tool_result").map((f) => f.data.payload.failed),
    ).toEqual([true, false]);
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

    expect(firstFrames).toHaveLength(13);
    expect(secondFrames).toHaveLength(13);
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

  it("finds them however the address was cased, since an email address is not case-sensitive", async () => {
    const mineEmail = reporter("Mixed.Case");
    const mine = await openTicket(mineEmail, "Checkout failed");

    const read = await get<{ tickets: Array<{ id: string }> }>(
      `/reporters/${encodeURIComponent(mineEmail.toUpperCase())}/tickets`,
    );

    expect(read.body.tickets.map((ticket) => ticket.id)).toEqual([mine.body.id]);
  });

  it("refuses an address that is not an email", async () => {
    const read = await get<ErrorBody>("/reporters/not-an-email/tickets");
    expect(read.status).toBe(400);
  });
});

describe("what portal-web reads off the portal", () => {
  it("serves the Resolver in use and the two tools a Ticket links out to", async () => {
    const served = await get<{ resolver: string; grafanaUrl: string; langfuseBaseUrl: string }>(
      "/config",
    );

    expect(served.status).toBe(200);
    expect(served.body).toEqual({
      resolver: "fake",
      grafanaUrl: config.infra.grafanaUrl,
      langfuseBaseUrl: config.infra.langfuseBaseUrl,
    });
  });
});

describe("a run that reports its trace", () => {
  const traceId = "9f8e7d6c5b4a39281706f5e4d3c2b1a0";

  /** Reports the Langfuse trace it is writing to before it does any work, as the agent does. */
  const tracingResolver: TicketResolver = {
    name: "tracing",
    async *resolve(): AsyncIterable<ResolverEvent> {
      yield { type: "trace", langfuseTraceId: traceId };
      yield { type: "verdict", verdict: FAKE_VERDICT };
    },
    resume: neverResumed,
  };

  it("puts the trace on the Ticket and leaves the timeline to what the run did", async () => {
    const [portal, portalUrl] = await startApi(tracingResolver);
    try {
      const created = await post<TicketBody>(`${portalUrl}/tickets`, {
        source: "tester",
        title: "Cart total wrong",
        body: "Stale badge",
      });

      const frames = await streamUntil(`${portalUrl}/tickets/${created.body.id}/events`, isClosed);
      expect(frames.map((frame) => frame.data.type)).toEqual(["verdict", "status"]);

      const closed = await get<TicketBody>(`${portalUrl}/tickets/${created.body.id}`);
      expect(closed.body.langfuseTraceId).toBe(traceId);
    } finally {
      await portal.close();
    }
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
    resume: neverResumed,
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

describe("the approval gate", () => {
  /** A cart of this test's own whose denormalised total has gone stale: demo moment two. */
  let customerId: string;
  let cartId: string;

  const proposal = () => ({
    sql: `UPDATE shoplite.cart_totals SET item_count = 1, total_cents = 1500 WHERE cart_id = '${cartId}'`,
    reason: "cart_totals still holds the count from before the item was removed",
  });

  /** The fake, configured to take that fix to the gate rather than answering outright. */
  const proposing = () => createFakeResolver({ propose: proposal() });

  async function totals(): Promise<{ item_count: number; total_cents: number } | undefined> {
    const { rows } = await db.$client.query<{ item_count: number; total_cents: number }>(
      "SELECT item_count, total_cents FROM shoplite.cart_totals WHERE cart_id = $1",
      [cartId],
    );
    return rows[0];
  }

  /** Opens a Ticket and waits for it to stop at the gate. */
  async function openAndWait(portalUrl: string): Promise<TicketBody> {
    const created = await post<TicketBody>(`${portalUrl}/tickets`, {
      source: "tester",
      title: "Cart total wrong",
      body: "Removing an item leaves the badge stale",
    });
    await streamUntil(`${portalUrl}/tickets/${created.body.id}/events`, isWaiting);
    return created.body;
  }

  beforeAll(async () => {
    const { rows } = await db.$client.query<{ id: string }>(
      "INSERT INTO shoplite.customers (email, name) VALUES ($1, 'Gate Test') RETURNING id",
      [`gate-${randomUUID()}@example.com`],
    );
    customerId = rows[0]?.id as string;
    const cart = await db.$client.query<{ id: string }>(
      "INSERT INTO shoplite.carts (customer_id, status) VALUES ($1, 'open') RETURNING id",
      [customerId],
    );
    cartId = cart.rows[0]?.id as string;
    await db.$client.query(
      "INSERT INTO shoplite.cart_totals (cart_id, item_count, subtotal_cents, total_cents) VALUES ($1, 4, 6000, 6000)",
      [cartId],
    );
  });

  afterAll(async () => {
    if (!customerId) return;
    await db.$client.query("DELETE FROM shoplite.carts WHERE customer_id = $1", [customerId]);
    await db.$client.query("DELETE FROM shoplite.customers WHERE id = $1", [customerId]);
  });

  it("stops at the Proposal with the SQL and the rows it would touch, and waits", async () => {
    const [portal, portalUrl] = await startApi(proposing());
    try {
      const ticket = await openAndWait(portalUrl);

      const waiting = await get<TicketBody>(`${portalUrl}/tickets/${ticket.id}`);
      expect(waiting.body.status).toBe("awaiting_approval");

      const open = await get<{ approvals: ApprovalBody[] }>(
        `${portalUrl}/tickets/${ticket.id}/approvals`,
      );
      const [approval] = open.body.approvals;
      expect(approval).toMatchObject({
        action: "apply_data_fix",
        allowedDecisions: ["approve", "edit", "reject"],
        decision: null,
      });
      expect(approval?.proposal).toMatchObject({
        kind: "data_fix",
        statement: "update",
        table: "shoplite.cart_totals",
        sql: proposal().sql,
        matchingRows: 1,
      });
      // The card shows the row as it is now, which is what makes the Decision an informed one.
      expect(approval?.preview).toMatchObject({ rowCount: 1 });
      const preview = approval?.preview as { rows: Array<Record<string, unknown>> };
      expect(preview.rows[0]).toMatchObject({ item_count: 4 });

      // Nothing has run: the fix waits for a person.
      expect(await totals()).toMatchObject({ item_count: 4 });
    } finally {
      await portal.close();
    }
  });

  it("corrects the row on approval and closes the Ticket data fixed", async () => {
    const [portal, portalUrl] = await startApi(proposing());
    try {
      const ticket = await openAndWait(portalUrl);

      const decided = await post<{ approval: ApprovalBody }>(
        `${portalUrl}/tickets/${ticket.id}/decision`,
        { decision: "approve" },
      );
      expect(decided.status).toBe(202);

      const frames = await streamUntil(`${portalUrl}/tickets/${ticket.id}/events`, isClosed);
      expect(
        frames.filter((f) => f.data.type === "status").map((frame) => frame.data.payload.status),
      ).toEqual(["triaging", "investigating", "awaiting_approval", "acting", "closed"]);
      expect(frames.some((frame) => frame.data.type === "decision")).toBe(true);

      expect(await totals()).toMatchObject({ item_count: 1, total_cents: 1500 });

      const closed = await get<TicketBody>(`${portalUrl}/tickets/${ticket.id}`);
      expect(closed.body.status).toBe("closed");
      expect(closed.body.outcome).toBe("data_fixed");

      // The approval keeps what ran and the rows as they were, so it can be undone.
      const after = await get<{ approvals: ApprovalBody[] }>(
        `${portalUrl}/tickets/${ticket.id}/approvals`,
      );
      expect(after.body.approvals[0]).toMatchObject({
        decision: "approve",
        result: { ran: true, rowCount: 1, table: "shoplite.cart_totals" },
      });
      expect(after.body.approvals[0]?.executedAt).not.toBeNull();
    } finally {
      await portal.close();
    }
  });

  it("runs the Reviewer's own statement when they edit the Proposal", async () => {
    const [portal, portalUrl] = await startApi(proposing());
    try {
      const ticket = await openAndWait(portalUrl);
      const edited = {
        kind: "data_fix",
        statement: "update",
        table: "shoplite.cart_totals",
        sql: `UPDATE shoplite.cart_totals SET item_count = 2, total_cents = 2500 WHERE cart_id = '${cartId}'`,
        reason: "Two lines, not one",
        matchingRows: 1,
        executed: false,
      };

      const decided = await post(`${portalUrl}/tickets/${ticket.id}/decision`, {
        decision: "edit",
        proposal: edited,
      });
      expect(decided.status).toBe(202);
      await streamUntil(`${portalUrl}/tickets/${ticket.id}/events`, isClosed);

      expect(await totals()).toMatchObject({ item_count: 2, total_cents: 2500 });
    } finally {
      await portal.close();
    }
  });

  it("changes nothing when the Reviewer rejects, and the agent is told why", async () => {
    const [portal, portalUrl] = await startApi(proposing());
    try {
      const ticket = await openAndWait(portalUrl);
      const before = await totals();

      const decided = await post(`${portalUrl}/tickets/${ticket.id}/decision`, {
        decision: "reject",
        reason: "That is the wrong cart",
      });
      expect(decided.status).toBe(202);

      const frames = await streamUntil(`${portalUrl}/tickets/${ticket.id}/events`, isClosed);
      const decision = frames.find((frame) => frame.data.type === "decision");
      expect(decision?.data.payload).toMatchObject({
        decision: "reject",
        reason: "That is the wrong cart",
      });

      expect(await totals()).toEqual(before);
      const closed = await get<TicketBody>(`${portalUrl}/tickets/${ticket.id}`);
      expect(closed.body.outcome).toBe("escalated");
      expect(closed.body.rootCause).toContain("wrong cart");
    } finally {
      await portal.close();
    }
  });

  it("refuses a second Decision on the same Proposal, and one on a Ticket that is not waiting", async () => {
    const [portal, portalUrl] = await startApi(proposing());
    try {
      const ticket = await openAndWait(portalUrl);
      await post(`${portalUrl}/tickets/${ticket.id}/decision`, { decision: "approve" });

      const again = await post<ErrorBody>(`${portalUrl}/tickets/${ticket.id}/decision`, {
        decision: "approve",
      });
      expect(again.status).toBe(409);

      await streamUntil(`${portalUrl}/tickets/${ticket.id}/events`, isClosed);
      const settled = await post<ErrorBody>(`${portalUrl}/tickets/${ticket.id}/decision`, {
        decision: "approve",
      });
      expect(settled.status).toBe(409);
    } finally {
      await portal.close();
    }
  });

  it("refuses a Decision the action's policy does not allow, and one with no reason", async () => {
    const [portal, portalUrl] = await startApi(proposing());
    try {
      const ticket = await openAndWait(portalUrl);

      const noReason = await post<ErrorBody>(`${portalUrl}/tickets/${ticket.id}/decision`, {
        decision: "reject",
      });
      expect(noReason.status).toBe(400);

      const noProposal = await post<ErrorBody>(`${portalUrl}/tickets/${ticket.id}/decision`, {
        decision: "edit",
      });
      expect(noProposal.status).toBe(400);
    } finally {
      await portal.close();
    }
  });
});

describe("a Verdict the approval records do not support", () => {
  /** Claims the data was fixed without ever proposing one, which no run should do. */
  const boastfulResolver: TicketResolver = {
    name: "boastful",
    async *resolve(): AsyncIterable<ResolverEvent> {
      yield {
        type: "verdict",
        verdict: {
          outcome: "data_fixed",
          category: "data_issue",
          confidence: 0.95,
          rootCause: "The cart total was stale.",
          evidence: [],
          reply: "We have corrected your cart total.",
        },
      };
    },
    resume: neverResumed,
  };

  it("escalates rather than telling the Reporter something was corrected", async () => {
    const [portal, portalUrl] = await startApi(boastfulResolver);
    try {
      const created = await post<TicketBody>(`${portalUrl}/tickets`, {
        source: "tester",
        title: "Cart total wrong",
        body: "Stale badge",
      });
      await streamUntil(`${portalUrl}/tickets/${created.body.id}/events`, isClosed);

      const closed = await get<TicketBody>(`${portalUrl}/tickets/${created.body.id}`);
      expect(closed.body.outcome).toBe("escalated");
      expect(closed.body.rootCause).toContain("escalated rather than closed as fixed");
      expect(closed.body.reply).toContain("member of the team");
    } finally {
      await portal.close();
    }
  });
});
