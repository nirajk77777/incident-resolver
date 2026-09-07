import { createDb, loadConfig, runMigrations, type Ticket } from "@incident-resolver/shared";
import type { MultiServerMCPClient } from "@langchain/mcp-adapters";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCheckpointer } from "./checkpointer";
import { interruptsFor } from "./interrupts";
import { createMcpClient } from "./mcp";
import { createModels } from "./models";
import { resolvePrompts } from "./prompts";
import { createResolver } from "./resolver";
import {
  dataInvestigatorToolNames,
  incidentHistorianToolNames,
  logInvestigatorToolNames,
  selectTools,
  triageToolNames,
} from "./subagents";

// Needs `docker compose up`, this repo's `pnpm db:migrate`, and ShopLite's
// `pnpm db:migrate && pnpm db:seed`. Run with `pnpm test:integration`.
//
// No model is called and no embedding is made: this proves the Resolver can be assembled the
// way the CLI assembles it. The MCP servers start with whatever keys the shell has, or with
// placeholders, since mcp-incidents only checks that COHERE_API_KEY is present and ChatOpenAI
// does not use its key until the first call.

const config = loadConfig();
const ava = { id: "00000000-0000-4000-8000-000000000001", email: "ava.chen@example.com" };

const customerTicket: Ticket = {
  id: "50000000-0000-4000-8000-000000000101",
  source: "customer",
  reporterEmail: ava.email,
  title: "Checkout failed",
  body: "Money not deducted.",
};

const placeholderKey = "placeholder-for-wiring-test";
const env = { ...process.env, COHERE_API_KEY: process.env.COHERE_API_KEY ?? placeholderKey };

describe("Resolver wiring", () => {
  const admin = createDb(config.infra.databaseUrl);
  let mcp: MultiServerMCPClient;

  beforeAll(async () => {
    await runMigrations(admin);
    const seeded = await admin.$client.query("SELECT 1 FROM shoplite.customers WHERE id = $1", [
      ava.id,
    ]);
    if (seeded.rowCount === 0) {
      throw new Error("ShopLite is not seeded: run `pnpm db:migrate && pnpm db:seed` in shoplite");
    }
    mcp = createMcpClient(customerTicket, env);
  });

  afterAll(async () => {
    await mcp?.close();
    await admin.$client.end();
  });

  it("loads the observability, database, and incidents tools through the MCP client", async () => {
    const tools = await mcp.getTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "describe_schema",
      "get_error_rate",
      "get_incident",
      "get_trace",
      "list_recent_errors",
      "propose_data_fix",
      "query_metrics",
      "run_readonly_sql",
      "save_incident",
      "search_help_articles",
      "search_logs",
      "search_similar_incidents",
    ]);
  });

  it("gives Triage and each Investigator only its own server's tools", async () => {
    const tools = await mcp.getTools();
    const names = (selected: readonly string[]) =>
      selectTools(tools, selected).map((tool) => tool.name);

    expect(names(triageToolNames)).toEqual(["search_help_articles"]);
    expect(names(logInvestigatorToolNames)).toEqual([
      "search_logs",
      "get_trace",
      "query_metrics",
      "get_error_rate",
      "list_recent_errors",
    ]);
    expect(names(dataInvestigatorToolNames)).toEqual([
      "describe_schema",
      "run_readonly_sql",
      "propose_data_fix",
    ]);
    // save_incident is a write at Ticket close, not the Historian's to make.
    expect(names(incidentHistorianToolNames)).toEqual(["search_similar_incidents", "get_incident"]);
    expect(() => selectTools(tools, ["run_tests"])).toThrow(/run_tests/);
  });

  it("starts the database server scoped to the customer Ticket's reporter", async () => {
    const [runSql] = selectTools(await mcp.getTools(), ["run_readonly_sql"]);
    if (!runSql) throw new Error("run_readonly_sql not loaded");
    expect(runSql.description).toContain(`customer_id = '${ava.id}'`);

    // Unscoped SQL is refused by the server and surfaces to the agent as a tool error it can correct.
    await expect(
      runSql.invoke({
        sql: "SELECT status FROM shoplite.payments ORDER BY created_at DESC LIMIT 1",
      }),
    ).rejects.toThrow(/customer_id/);

    const result = await runSql.invoke({
      sql: `SELECT status, decline_code FROM shoplite.payments WHERE customer_id = '${ava.id}' ORDER BY created_at DESC LIMIT 1`,
    });
    expect(String(result)).toContain('"status": "declined"');
  });

  it("assembles the deep agent with a Postgres checkpointer in the portal schema", async () => {
    const checkpointer = await createCheckpointer(config);
    try {
      const { rows } = await admin.$client.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'portal' AND table_name LIKE 'checkpoint%' ORDER BY 1",
      );
      expect(rows.map((row) => row.table_name)).toContain("checkpoints");

      const resolver = createResolver({
        config,
        models: createModels(config, process.env.OPENAI_API_KEY ?? placeholderKey),
        tools: await mcp.getTools(),
        prompts: await resolvePrompts({
          label: config.infra.langfusePromptLabel,
          variables: { confidenceThreshold: config.confidenceThreshold },
        }),
        checkpointer,
        writeEffects: {
          applyDataFix: async () => "not reached",
          sendCustomerReply: async () => "not reached",
          createPullRequest: async () => "not reached",
        },
        interruptOn: interruptsFor(customerTicket),
      });
      expect(resolver).toBeDefined();
      const tuple = await checkpointer.getTuple({
        configurable: { thread_id: `${customerTicket.id}:wiring` },
      });
      expect(tuple).toBeUndefined();
    } finally {
      await checkpointer.end();
    }
  });
});
