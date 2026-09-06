import { fileURLToPath } from "node:url";
import { createDb, type Db, loadConfig, runMigrations } from "@incident-resolver/shared";
import type { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type { MultiServerMCPClient } from "@langchain/mcp-adapters";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCheckpointer } from "./checkpointer";
import { readTicket } from "./cli-args";
import { createMcpClient } from "./mcp";
import { createModels } from "./models";
import { createResolver, defaultThreadId, type Resolver, resolveTicket } from "./resolver";
import { DATA_INVESTIGATOR, TRIAGE } from "./subagents";
import { startTracing, type Tracing, traceRun } from "./tracing";

// The first end-to-end agent slice, driven the way the CLI drives it. Needs `docker compose up`,
// this repo's `pnpm db:migrate` and `pnpm seed:incidents`, ShopLite migrated and seeded, and
// OPENAI_API_KEY plus COHERE_API_KEY. Without both keys the suite is skipped. With the Langfuse
// keys set too, each run lands in Langfuse under a session named after the Ticket id.

const config = loadConfig();
const openAiApiKey = process.env.OPENAI_API_KEY;
const hasApiKeys = Boolean(openAiApiKey && process.env.COHERE_API_KEY);
const fixture = (name: string) =>
  fileURLToPath(new URL(`../tickets/${name}.json`, import.meta.url));

describe.skipIf(!hasApiKeys)(
  "Resolver end to end",
  () => {
    const clients: MultiServerMCPClient[] = [];
    let admin: Db;
    let tracing: Tracing;
    let checkpointer: PostgresSaver;

    beforeAll(async () => {
      admin = createDb(config.infra.databaseUrl);
      await runMigrations(admin);
      const articles = await admin.$client.query(
        "SELECT count(*)::int AS n FROM knowledge.help_articles",
      );
      if (articles.rows[0]?.n === 0) {
        throw new Error("No Help articles: run `pnpm seed:incidents` first");
      }
      const declined = await admin.$client.query(
        "SELECT 1 FROM shoplite.payments WHERE status = 'declined' AND customer_id = $1 LIMIT 1",
        ["00000000-0000-4000-8000-000000000001"],
      );
      if (declined.rowCount === 0) {
        throw new Error(
          "Ava Chen has no declined payment: run a checkout with a card ending 0002 against ShopLite first",
        );
      }
      tracing = startTracing({
        publicKey: process.env.LANGFUSE_PUBLIC_KEY,
        secretKey: process.env.LANGFUSE_SECRET_KEY,
        baseUrl: config.infra.langfuseBaseUrl,
      });
      checkpointer = await createCheckpointer(config);
    });

    afterAll(async () => {
      await Promise.all(clients.map((client) => client.close()));
      await checkpointer?.end();
      await admin?.$client.end();
      await tracing?.shutdown();
    });

    async function run(name: string) {
      const ticket = await readTicket(fixture(name));
      const mcp = createMcpClient(ticket);
      clients.push(mcp);
      const tools = await mcp.getTools();
      const models = createModels(config, openAiApiKey as string);
      const resolver: Resolver = createResolver({ config, models, tools, checkpointer });
      const threadId = defaultThreadId(ticket);
      return traceRun(ticket, config.models, (callbacks) =>
        resolveTicket({ resolver, ticket, threadId, config, callbacks }),
      );
    }

    it("answers the images-not-loading Ticket from the clear cache article without an Investigator", async () => {
      const report = await run("images-not-loading");

      expect(report.verdict.outcome).toBe("answered");
      expect(report.verdict.category).toBe("question");
      expect(report.subagentsInvoked).toEqual([TRIAGE]);
      expect(report.fastPath).toBe(true);
      expect(report.triage?.helpArticleIds).toContain("40000000-0000-4000-8000-000000000001");
      expect(report.verdict.reply).toMatch(/refresh|cache/i);
      expect(report.warnings).toEqual([]);
    });

    it("answers the declined-card Ticket from the payments table with a plain-language Reply", async () => {
      const report = await run("declined-card");

      expect(report.verdict.outcome).toBe("answered");
      expect(report.verdict.category).toBe("user_error");
      expect(report.subagentsInvoked).toContain(DATA_INVESTIGATOR);
      expect(report.fastPath).toBe(false);
      expect(report.verdict.reply).toMatch(/declin/i);
      expect(report.verdict.reply).not.toMatch(/shoplite\.payments|SELECT/);
      expect(report.verdict.evidence.some((item) => /payments/i.test(item.provenance))).toBe(true);
    });
  },
  300_000,
);
