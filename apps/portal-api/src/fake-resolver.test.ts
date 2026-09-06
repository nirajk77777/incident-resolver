import { verdictSchema } from "@incident-resolver/shared";
import { describe, expect, it } from "vitest";
import { createFakeResolver } from "./fake-resolver";
import type { ResolverEvent } from "./resolver";

const ticket = {
  id: "00000000-0000-4000-8000-000000000001",
  source: "customer" as const,
  reporterEmail: "ava.chen@example.com",
  title: "Checkout failed",
  body: "My card was refused at checkout",
};

async function collect(signal?: AbortSignal): Promise<ResolverEvent[]> {
  const events: ResolverEvent[] = [];
  for await (const event of createFakeResolver().resolve({ ticket, run: 1, signal })) {
    events.push(event);
  }
  return events;
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
      "subagent_end",
      "message",
      "verdict",
    ]);
    expect(events[0]).toMatchObject({ type: "subagent_start", name: "triage" });
  });

  it("ends with a Verdict the portal can close a Ticket from", async () => {
    const events = await collect();
    const last = events.at(-1);
    expect(last?.type).toBe("verdict");
    const verdict = verdictSchema.parse(last?.type === "verdict" ? last.verdict : undefined);
    expect(verdict.outcome).toBe("answered");
    expect(verdict.reply).not.toHaveLength(0);
  });

  it("throws when the run is aborted, so a cancelled run never looks resolved", async () => {
    await expect(collect(AbortSignal.abort())).rejects.toThrow(/abort/i);
  });
});
