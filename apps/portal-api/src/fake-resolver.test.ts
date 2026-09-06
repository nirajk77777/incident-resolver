import type { WriteEffects } from "@incident-resolver/agents";
import { verdictSchema } from "@incident-resolver/shared";
import { describe, expect, it } from "vitest";
import { createFakeResolver } from "./fake-resolver";
import type { ResolverDecision, ResolverEvent, TicketResolver } from "./resolver";

const ticket = {
  id: "00000000-0000-4000-8000-000000000001",
  source: "customer" as const,
  reporterEmail: "ava.chen@example.com",
  title: "Checkout failed",
  body: "My card was refused at checkout",
};

const staleTotal = {
  sql: "UPDATE shoplite.cart_totals SET item_count = 1 WHERE cart_id = '11111111-1111-4111-8111-111111111111'",
  reason: "The badge kept the count from before the item was removed",
};

function spyEffects(): WriteEffects & { applied: string[] } {
  const applied: string[] = [];
  return {
    applied,
    async applyDataFix({ sql }) {
      applied.push(sql);
      return "The fix ran. 1 row(s) of shoplite.cart_totals were corrected by the UPDATE.";
    },
    async sendCustomerReply({ text }) {
      return `Sent: ${text}`;
    },
  };
}

async function drain(stream: AsyncIterable<ResolverEvent>): Promise<ResolverEvent[]> {
  const events: ResolverEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const verdictOf = (events: ResolverEvent[]) => {
  const last = events.at(-1);
  return verdictSchema.parse(last?.type === "verdict" ? last.verdict : undefined);
};

/** Drains until the stream ends or throws, keeping what it managed to yield either way. */
async function drainCatching(
  stream: AsyncIterable<ResolverEvent>,
  into: ResolverEvent[],
): Promise<unknown> {
  try {
    for await (const event of stream) into.push(event);
    return undefined;
  } catch (error) {
    return error;
  }
}

async function collect(signal?: AbortSignal): Promise<ResolverEvent[]> {
  return drain(createFakeResolver().resolve({ ticket, run: 1, effects: spyEffects(), signal }));
}

/** The same Ticket as a tester would have opened it: no Reporter, and so no tenant scope. */
const testerTicket = { ...ticket, source: "tester" as const, reporterEmail: undefined };

/** The fake configured to propose a data fix, and the effects it will run it through. */
function proposing(): { resolver: TicketResolver; effects: WriteEffects & { applied: string[] } } {
  return { resolver: createFakeResolver({ propose: staleTotal }), effects: spyEffects() };
}

describe("the fake Resolver", () => {
  it("walks Triage and an Investigator, then ends on a Verdict", async () => {
    const events = await collect();
    expect(events.map((event) => event.type)).toEqual([
      "subagent_start",
      "subagent_end",
      "subagent_start",
      "tool_call",
      "tool_result",
      "tool_call",
      "tool_result",
      "subagent_end",
      "message",
      "verdict",
    ]);
    expect(events[0]).toMatchObject({ type: "subagent_start", name: "triage" });
  });

  it("has the tenant guard turn away the unscoped query it tries first", async () => {
    const events = await collect();
    const results = events.filter((event) => event.type === "tool_result");

    expect(results[0]).toMatchObject({ name: "run_readonly_sql", failed: true });
    expect(results[1]?.failed).toBeUndefined();
  });

  it("tries nothing unscoped on a tester Ticket, which has no customer to be scoped to", async () => {
    const events = await drain(
      createFakeResolver().resolve({ ticket: testerTicket, run: 1, effects: spyEffects() }),
    );

    expect(events.some((event) => event.type === "tool_result" && event.failed)).toBe(false);
  });

  it("ends with a Verdict the portal can close a Ticket from", async () => {
    const verdict = verdictOf(await collect());
    expect(verdict.outcome).toBe("answered");
    expect(verdict.reply).not.toHaveLength(0);
  });

  it("throws when the run is aborted, so a cancelled run never looks resolved", async () => {
    await expect(collect(AbortSignal.abort())).rejects.toThrow(/abort/i);
  });
});

describe("the fake Resolver at the approval gate", () => {
  it("ends its first stream on the Proposal, with no Verdict", async () => {
    const { resolver, effects } = proposing();
    const events = await drain(resolver.resolve({ ticket, run: 1, effects }));

    const last = events.at(-1);
    expect(last).toEqual({ type: "interrupt", action: "apply_data_fix", args: staleTotal });
    expect(events.some((event) => event.type === "verdict")).toBe(false);
    expect(effects.applied).toEqual([]);
  });

  it("runs the approved fix through the portal's effect and ends data fixed", async () => {
    const { resolver, effects } = proposing();
    const approve: ResolverDecision = { action: "apply_data_fix", decision: "approve" };

    const events = await drain(resolver.resume({ ticket, run: 1, effects }, approve));

    expect(effects.applied).toEqual([staleTotal.sql]);
    expect(verdictOf(events).outcome).toBe("data_fixed");
  });

  it("runs the Reviewer's own statement when they edited it", async () => {
    const { resolver, effects } = proposing();
    const corrected = { ...staleTotal, sql: `${staleTotal.sql} AND item_count <> 1` };

    await drain(
      resolver.resume(
        { ticket, run: 1, effects },
        {
          action: "apply_data_fix",
          decision: "edit",
          proposal: {
            kind: "data_fix",
            statement: "update",
            table: "shoplite.cart_totals",
            sql: corrected.sql,
            reason: corrected.reason,
            matchingRows: 1,
            executed: false,
          },
        },
      ),
    );

    expect(effects.applied).toEqual([corrected.sql]);
  });

  it("writes nothing when the Reviewer rejected it, and escalates with their reason", async () => {
    const { resolver, effects } = proposing();

    const events = await drain(
      resolver.resume(
        { ticket, run: 1, effects },
        { action: "apply_data_fix", decision: "reject", reason: "The wrong cart" },
      ),
    );

    expect(effects.applied).toEqual([]);
    const verdict = verdictOf(events);
    expect(verdict.outcome).toBe("escalated");
    expect(verdict.rootCause).toContain("The wrong cart");
  });
});

/**
 * The two ways a run ends without a Verdict. The portal is what turns either into a closed,
 * escalated Ticket; the fake's job is to be a Resolver that genuinely does these things, so
 * that behaviour is exercised end to end rather than mocked.
 */
describe("a fake Resolver configured to fail", () => {
  it("reports what it managed before it broke, then throws", async () => {
    const broken = createFakeResolver({ fail: "the model went away" });
    const events: ResolverEvent[] = [];

    const thrown = await drainCatching(
      broken.resolve({ ticket, run: 1, effects: spyEffects() }),
      events,
    );

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("the model went away");
    expect(events.map((event) => event.type)).toContain("subagent_start");
    expect(events.some((event) => event.type === "verdict")).toBe(false);
  });
});

describe("a fake Resolver configured to hang", () => {
  it("waits until its run is abandoned, and never reaches a Verdict", async () => {
    const hanging = createFakeResolver({ hang: true });
    const signal = AbortSignal.timeout(50);
    const events: ResolverEvent[] = [];

    const thrown = await drainCatching(
      hanging.resolve({ ticket, run: 1, effects: spyEffects(), signal }),
      events,
    );

    expect(thrown).toBeInstanceOf(Error);
    expect(events.some((event) => event.type === "verdict")).toBe(false);
  });
});
