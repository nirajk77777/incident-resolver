import { fileURLToPath } from "node:url";
import { createDb, loadConfig, runMigrations } from "@incident-resolver/shared";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type { MultiServerMCPClient } from "@langchain/mcp-adapters";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readTicket } from "./cli-args";
import { createMcpClient } from "./mcp";
import { createModels } from "./models";
import { createResolver, type Resolver, resolveTicket } from "./resolver";
import { DATA_INVESTIGATOR, TRIAGE } from "./subagents";
import { startTracing, traceRun } from "./tracing";

// The first end-to-end agent slice, driven the way the CLI drives it. Needs `docker compose up`,
// this repo's `pnpm db:migrate` and `pnpm seed:incidents`, ShopLite migrated and seeded, and
// OPENAI_API_KEY plus COHERE_API_KEY. Without both keys the suite is skipped. With the Langfuse
// keys set too, each run lands in Langfuse under a session named after the Ticket id.

const config = loadConfig();
const keys = Boolean(process.env.OPENAI_API_KEY && process.env.COHERE_API_KEY);
const fixture = (name: string) =>
  fileURLToPath(new URL(`../tickets/${name}.json`, import.meta.url));

describe.skipIf(!keys)(
  "Resolver end to end",
  () => {
    const admin = createDb(config.infra.databaseUrl);
    const tracing = startTracing();
    const clients: MultiServerMCPClient[] = [];
    let checkpointer: PostgresSaver;

    beforeAll(async () => {
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
      checkpointer = PostgresSaver.fromConnString(config.infra.databaseUrl, { schema: "portal" });
      await checkpointer.setup();
    });

    afterAll(async () => {
      await Promise.all(clients.map((client) => client.close()));
      await checkpointer?.end();
      await admin.$client.end();
      await tracing.shutdown();
    });

    async function resolverFor(
      name: string,
    ): Promise<{ resolver: Resolver; ticket: Awaited<ReturnType<typeof readTicket>> }> {
      const ticket = await readTicket(fixture(name));
      const mcp = createMcpClient(ticket);
      clients.push(mcp);
      const tools = await mcp.getTools();
      const resolver = createResolver({
        config,
        models: createModels(config),
        tools,
        checkpointer,
      });
      return { resolver, ticket };
    }

    it("answers the images-not-loading Ticket from the clear cache article without an Investigator", async () => {
      const { resolver, ticket } = await resolverFor("images-not-loading");
      const threadId = `${ticket.id}:${new Date().toISOString()}`;
      const result = await traceRun(ticket, config.models, (callbacks) =>
        resolveTicket({ resolver, ticket, threadId, config, callbacks }),
      );

      expect(result.verdict.outcome).toBe("answered");
      expect(result.verdict.category).toBe("question");
      expect(result.subagentsInvoked).toEqual([TRIAGE]);
      expect(result.fastPath).toBe(true);
      expect(result.triage?.helpArticleIds).toContain("40000000-0000-4000-8000-000000000001");
      expect(result.verdict.reply).toMatch(/refresh|cache/i);
      expect(result.warnings).toEqual([]);
    });

    it("answers the declined-card Ticket from the payments table with a plain-language Reply", async () => {
      const { resolver, ticket } = await resolverFor("declined-card");
      const threadId = `${ticket.id}:${new Date().toISOString()}`;
      const result = await traceRun(ticket, config.models, (callbacks) =>
        resolveTicket({ resolver, ticket, threadId, config, callbacks }),
      );

      expect(result.verdict.outcome).toBe("answered");
      expect(result.verdict.category).toBe("user_error");
      expect(result.subagentsInvoked).toContain(DATA_INVESTIGATOR);
      expect(result.fastPath).toBe(false);
      expect(result.verdict.reply).toMatch(/declin/i);
      expect(result.verdict.reply).not.toMatch(/shoplite\.payments|SELECT/);
      expect(result.verdict.evidence.some((item) => /payments/i.test(item.provenance))).toBe(true);
    });
  },
  300_000,
);
