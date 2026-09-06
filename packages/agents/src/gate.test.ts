import { loadConfig, type Ticket } from "@incident-resolver/shared";
import { fakeModel } from "@langchain/core/testing";
import { MemorySaver } from "@langchain/langgraph";
import { type Decision, tool } from "langchain";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { interruptsFor } from "./interrupts";
import type { Models } from "./models";
import { loadPrompt, type Prompts } from "./prompts";
import {
  createResolver,
  freshThreadId,
  type ResolveOptions,
  resolveTicket,
  resumeTicket,
} from "./resolver";
import {
  dataInvestigatorToolNames,
  incidentHistorianToolNames,
  logInvestigatorToolNames,
  triageToolNames,
} from "./subagents";
import type { WriteEffects } from "./write-tools";

// The gate itself, with a scripted model in place of a real one: the graph must stop before a
// write runs, hold the Proposal, and let it through only on a Decision. Everything here is in
// memory, so this is the cheap check that the wiring works; that a Ticket then closes
// `data_fixed` is the portal's, and is checked over HTTP in apps/portal-api.

const config = loadConfig();

const ticket: Ticket = {
  id: "3f7c1b52-8f0f-4a9f-9b1a-2c9d5e6f7a80",
  source: "tester",
  title: "Cart total wrong",
  body: "Removing an item leaves the badge stale",
};

const fix = {
  sql: "UPDATE shoplite.cart_totals SET item_count = 1 WHERE cart_id = '11111111-1111-4111-8111-111111111111'",
  reason: "The badge kept the count from before the item was removed",
};

/** Prompts straight from the repository: this test is about the graph, not about wording. */
const prompts: Prompts = {
  label: "test",
  resolved: [],
  text: (name) => loadPrompt(name, { confidenceThreshold: config.confidenceThreshold }),
};

/**
 * Stand-ins for the MCP tools the subagents are built from. The scripted model never calls
 * one; they exist so the graph can be assembled without spawning three MCP servers.
 */
const stubTools = [
  ...triageToolNames,
  ...logInvestigatorToolNames,
  ...dataInvestigatorToolNames,
  ...incidentHistorianToolNames,
].map((name) => tool(async () => "not called", { name, description: name, schema: z.object({}) }));

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

/** A run whose model asks for the data fix on its first turn and has nothing to say after it. */
function gatedRun(effects: WriteEffects): ResolveOptions {
  const model = fakeModel().respondWithTools([
    { name: "apply_data_fix", args: fix, id: "call-1" },
  ]) as unknown as Models["resolver"];
  const resolver = createResolver({
    config,
    models: { resolver: model, triage: model, investigator: model },
    tools: stubTools,
    prompts,
    checkpointer: new MemorySaver(),
    writeEffects: effects,
    interruptOn: interruptsFor(ticket),
  });
  return { resolver, ticket, threadId: freshThreadId(ticket), config, prompts };
}

/**
 * Carries the paused run on and lets it end however it likes. The scripted model has one turn
 * in it and so never reaches a Verdict; what this test watches is what the Decision let
 * through, which has already happened by the time the run runs out of things to say.
 */
async function decide(options: ResolveOptions, decisions: Decision[]): Promise<void> {
  await resumeTicket(options, decisions).catch(() => undefined);
}

describe("a run that asks to write", () => {
  it("stops before the tool runs, holding the Proposal it asked about", async () => {
    const effects = spyEffects();
    const stop = await resolveTicket(gatedRun(effects));

    expect(stop.at).toBe("gate");
    if (stop.at !== "gate") return;
    expect(stop.proposals).toHaveLength(1);
    expect(stop.proposals[0]).toMatchObject({ name: "apply_data_fix", args: fix });
    expect(effects.applied).toEqual([]);
  });

  it("runs the write once the Reviewer approves it", async () => {
    const effects = spyEffects();
    const options = gatedRun(effects);
    await resolveTicket(options);

    await decide(options, [{ type: "approve" }]);

    expect(effects.applied).toEqual([fix.sql]);
  });

  it("runs the Reviewer's own statement when they edit it", async () => {
    const effects = spyEffects();
    const options = gatedRun(effects);
    await resolveTicket(options);
    const corrected = `${fix.sql} AND item_count <> 1`;

    await decide(options, [
      { type: "edit", editedAction: { name: "apply_data_fix", args: { ...fix, sql: corrected } } },
    ]);

    expect(effects.applied).toEqual([corrected]);
  });

  it("writes nothing when the Reviewer rejects it", async () => {
    const effects = spyEffects();
    const options = gatedRun(effects);
    await resolveTicket(options);

    await decide(options, [{ type: "reject", message: "That is the wrong cart" }]);

    expect(effects.applied).toEqual([]);
  });
});
