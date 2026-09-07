import { loadConfig, type Ticket } from "@incident-resolver/shared";
import { fakeModel } from "@langchain/core/testing";
import { MemorySaver } from "@langchain/langgraph";
import { type Decision, tool } from "langchain";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { githubToolNames } from "./github";
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
import type { Workspace } from "./workspace";
import type { PullRequestRequest, WriteEffects } from "./write-tools";

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
  ...githubToolNames,
].map((name) =>
  tool(async () => "not called", { name, description: name, schema: z.object({}).loose() }),
);

/** A Workspace that is never read: the scripted model asks for the write and nothing else. */
const workspace: Workspace = {
  ticketId: ticket.id,
  dir: "/nowhere",
  async ready() {},
  async run() {
    return { exitCode: 0, stdout: "", stderr: "" };
  },
};

const pullRequest = {
  title: "fix: apply the percentage discount once per order",
  body: "## Root cause\nIt is applied twice.",
  files: ["apps/api/src/domain/order.ts"],
};

type Spy = WriteEffects & { applied: string[]; opened: PullRequestRequest[] };

function spyEffects(): Spy {
  const applied: string[] = [];
  const opened: PullRequestRequest[] = [];
  return {
    applied,
    opened,
    async applyDataFix({ sql }) {
      applied.push(sql);
      return "The fix ran. 1 row(s) of shoplite.cart_totals were corrected by the UPDATE.";
    },
    async sendCustomerReply({ text }) {
      return `Sent: ${text}`;
    },
    async createPullRequest(request, result) {
      opened.push(request);
      return result.ok ? `Opened ${result.url}` : `Not opened: ${result.reason}`;
    },
  };
}

/** The scripted model: one write on its first turn, and nothing to say after it. */
const model = fakeModel().respondWithTools([]) as unknown as Models["resolver"];

/** A run whose model asks for one write on its first turn and has nothing to say after it. */
function gatedRun(
  effects: WriteEffects,
  asks: { name: string; args: Record<string, unknown> } = { name: "apply_data_fix", args: fix },
  github?: { repo: { owner: string; repo: string }; base: string },
): ResolveOptions {
  const model = fakeModel().respondWithTools([
    { ...asks, id: "call-1" },
  ]) as unknown as Models["resolver"];
  const resolver = createResolver({
    config,
    models: {
      resolver: model,
      triage: model,
      investigator: model,
      codeRca: model,
      fixShipper: model,
    },
    tools: stubTools,
    prompts,
    checkpointer: new MemorySaver(),
    writeEffects: effects,
    interruptOn: interruptsFor(ticket),
    ...(github ? { workspace, github } : {}),
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

describe("a run that asks to open a pull request", () => {
  const asks = { name: "create_pull_request", args: pullRequest };
  const github = { repo: { owner: "nirajk77777", repo: "shoplite" }, base: "main" };

  it("stops before GitHub is touched, holding the branch, the files, and the RCA", async () => {
    const effects = spyEffects();
    const stop = await resolveTicket(gatedRun(effects, asks, github));

    expect(stop.at).toBe("gate");
    if (stop.at !== "gate") return;
    expect(stop.proposals[0]).toMatchObject({ name: "create_pull_request", args: pullRequest });
    expect(effects.opened).toEqual([]);
  });

  it("opens it once the Reviewer approves, and only then", async () => {
    const effects = spyEffects();
    const options = gatedRun(effects, asks, github);
    await resolveTicket(options);

    await decide(options, [{ type: "approve" }]);

    expect(effects.opened).toEqual([pullRequest]);
  });

  it("opens nothing when the Reviewer rejects it", async () => {
    const effects = spyEffects();
    const options = gatedRun(effects, asks, github);
    await resolveTicket(options);

    await decide(options, [{ type: "reject", message: "Not this release" }]);

    expect(effects.opened).toEqual([]);
  });

  it("still stops for a Reviewer on a run with no GitHub server to open it on", async () => {
    const effects = spyEffects();
    const options = gatedRun(effects, asks);
    const stop = await resolveTicket(options);

    expect(stop.at).toBe("gate");
    await decide(options, [{ type: "approve" }]);
    // The Proposal reached the effect, which is what records it; what it records is that
    // there was nowhere to open it, rather than a pull request nobody can find.
    expect(effects.opened).toEqual([pullRequest]);
  });

  it("builds a Resolver for every other Ticket when the GitHub tools did not load", async () => {
    // GITHUB_MCP_TOOLSETS decides what the remote server exposes, so a portal configured
    // without the pull requests toolset connects and loads fewer tools than this run needs.
    // That must cost the run its Fix Shipper, not cost the portal every Ticket it has.
    const effects = spyEffects();
    const withoutGithubTools = createResolver({
      config,
      models: {
        resolver: model,
        triage: model,
        investigator: model,
        codeRca: model,
        fixShipper: model,
      },
      tools: stubTools.filter((one) => !githubToolNames.includes(one.name as never)),
      prompts,
      checkpointer: new MemorySaver(),
      writeEffects: effects,
      interruptOn: interruptsFor(ticket),
      workspace,
      github,
    });

    expect(withoutGithubTools).toBeDefined();
  });
});
