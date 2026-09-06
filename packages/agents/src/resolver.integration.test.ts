import { fileURLToPath } from "node:url";
import { seedIncidentIds } from "@incident-resolver/mcp-incidents";
import { createDb, type Db, loadConfig, messageOf, runMigrations } from "@incident-resolver/shared";
import type { Callbacks } from "@langchain/core/callbacks/manager";
import type { StructuredTool } from "@langchain/core/tools";
import type { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type { MultiServerMCPClient } from "@langchain/mcp-adapters";
import type { Decision } from "langchain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCheckpointer } from "./checkpointer";
import { readTicket } from "./cli-args";
import { interruptsFor } from "./interrupts";
import { createMcpClient } from "./mcp";
import { createModels } from "./models";
import { type Prompts, resolvePrompts } from "./prompts";
import {
  createResolver,
  freshThreadId,
  type Resolver,
  type RunReport,
  type RunStop,
  resolveTicket,
  resumeTicket,
} from "./resolver";
import {
  DATA_INVESTIGATOR,
  INCIDENT_HISTORIAN,
  LOG_INVESTIGATOR,
  selectTools,
  TRIAGE,
} from "./subagents";
import { startTracing, type Tracing, traceRun } from "./tracing";
import type { WriteEffects } from "./write-tools";

// The end-to-end agent slice, driven the way the CLI drives it. Needs `docker compose up`,
// this repo's `pnpm db:migrate` and `pnpm seed:incidents`, ShopLite migrated, seeded, and
// running (`pnpm dev`, API on SHOPLITE_API_URL), and OPENAI_API_KEY plus COHERE_API_KEY.
// Without both keys the suite is skipped. With the Langfuse keys set too, each run lands in
// Langfuse under a session named after the Ticket id, and the prompts come from the label.
//
// The Tickets are made true before they are resolved: a declined checkout and a stale
// cart_totals row are generated against the running ShopLite, so the Investigators have
// something real to find in Loki, Tempo, and the database.

const config = loadConfig();
const openAiApiKey = process.env.OPENAI_API_KEY;
const hasApiKeys = Boolean(openAiApiKey && process.env.COHERE_API_KEY);
const shopliteApi = process.env.SHOPLITE_API_URL ?? "http://localhost:4000";
const fixture = (name: string) =>
  fileURLToPath(new URL(`../tickets/${name}.json`, import.meta.url));

const ava = { id: "00000000-0000-4000-8000-000000000001", email: "ava.chen@example.com" };
const mug = "00000000-0000-4000-9000-000000000001";
const tee = "00000000-0000-4000-9000-000000000002";
const declinedCard = { number: "4000000000000002", expMonth: 12, expYear: 2030 };
const traceIdPattern = /[0-9a-f]{32}/;

/** Every trace id and every provenance string a Verdict rests on, as one searchable blob. */
const evidenceText = (evidence: Array<{ fact: string; provenance: string }>) =>
  evidence.map((item) => `${item.fact} ${item.provenance}`).join("\n");

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${shopliteApi}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Retries until `attempt` returns a value, since ingestion into LGTM is asynchronous. */
async function pollUntil<T>(
  what: string,
  attempt: () => Promise<T | undefined>,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await attempt().catch(() => undefined);
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

describe.skipIf(!hasApiKeys)(
  "Resolver end to end",
  () => {
    const clients: MultiServerMCPClient[] = [];
    let admin: Db;
    let tracing: Tracing;
    let checkpointer: PostgresSaver;
    let prompts: Prompts;
    let declinedTraceId: string;

    beforeAll(async () => {
      admin = createDb(config.infra.databaseUrl);
      await runMigrations(admin);
      const articles = await admin.$client.query(
        "SELECT count(*)::int AS n FROM knowledge.help_articles",
      );
      if (articles.rows[0]?.n === 0) {
        throw new Error("No Help articles: run `pnpm seed:incidents` first");
      }
      const health = await fetch(`${shopliteApi}/health`).catch(() => undefined);
      if (!health?.ok) {
        throw new Error(`ShopLite is not running on ${shopliteApi}: run \`pnpm dev\` in shoplite`);
      }

      // Demo moment 1: a checkout the mock gateway declines, so the payments row and the
      // decline log line the Investigators cite both exist and are minutes old. The stale
      // cart_totals row demo moment 2 needs is made in its own test, not here.
      await post(`/customers/${ava.id}/cart/items`, { productId: mug });
      const checkout = await post(`/customers/${ava.id}/checkout`, { card: declinedCard });
      expect(checkout.status).toBe(402);
      declinedTraceId = checkout.headers.get("x-trace-id") as string;
      expect(declinedTraceId).toMatch(/^[0-9a-f]{32}$/);

      tracing = startTracing({
        publicKey: process.env.LANGFUSE_PUBLIC_KEY,
        secretKey: process.env.LANGFUSE_SECRET_KEY,
        baseUrl: config.infra.langfuseBaseUrl,
      });
      prompts = await resolvePrompts({
        label: config.infra.langfusePromptLabel,
        variables: { confidenceThreshold: config.confidenceThreshold },
      });
      checkpointer = await createCheckpointer(config);
    });

    afterAll(async () => {
      await Promise.all(clients.map((client) => client.close()));
      await checkpointer?.end();
      await admin?.$client.end();
      await tracing?.shutdown();
    });

    /**
     * The Reviewer these runs get: approves everything, and stands in for the portal by
     * running the approved statement itself. The guard on that statement, and the transaction
     * and snapshot around it, are the portal's and are covered by its own tests; what matters
     * here is that the gate stops the run, the Decision carries it on, and the Verdict knows
     * the fix ran.
     */
    function approvingEffects(applied: string[]): WriteEffects {
      return {
        async applyDataFix({ sql }) {
          applied.push(sql);
          const client = await admin.$client.connect();
          try {
            await client.query("BEGIN");
            // The role the portal runs an approved fix as has search_path = shoplite, so an
            // unqualified `UPDATE cart_totals` resolves. This connection is the superuser's,
            // so the same has to be said here for the statement to mean the same thing.
            await client.query("SET LOCAL search_path = shoplite");
            const result = await client.query(sql);
            await client.query("COMMIT");
            return `The fix ran. ${result.rowCount ?? 0} row(s) changed.`;
          } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            // Reported the way the portal's own effect reports it, so the Resolver can decide
            // around a statement that would not run rather than the run failing here.
            return `The fix did not run and nothing was changed. ${messageOf(error)}`;
          } finally {
            client.release();
          }
        },
        async sendCustomerReply({ text }) {
          return `Sent: ${text}`;
        },
      };
    }

    /** One run, carried through the gate to its Verdict, with the statements it ran. */
    async function run(name: string): Promise<{ report: RunReport; applied: string[] }> {
      const ticket = await readTicket(fixture(name));
      const mcp = createMcpClient(ticket);
      clients.push(mcp);
      const tools = await mcp.getTools();
      const models = createModels(config, openAiApiKey as string);
      const applied: string[] = [];
      const resolver: Resolver = createResolver({
        config,
        models,
        tools,
        prompts,
        checkpointer,
        writeEffects: approvingEffects(applied),
        interruptOn: interruptsFor(ticket),
      });
      const options = { resolver, ticket, threadId: freshThreadId(ticket), config, prompts };
      const trace = (go: (callbacks: Callbacks) => Promise<RunStop>) =>
        traceRun({ ticket, models: config.models, prompts }, go);

      let stop = await trace((callbacks) => resolveTicket({ ...options, callbacks }));
      while (stop.at === "gate") {
        const approvals = stop.proposals.map((): Decision => ({ type: "approve" }));
        stop = await trace((callbacks) => resumeTicket({ ...options, callbacks }, approvals));
      }
      return { report: stop.report, applied };
    }

    /**
     * Demo moment 2's planted bug, made true. Removing a line leaves cart_totals holding the
     * old count, because removeItem never refreshes the denormalised row. Done immediately
     * before the run that needs it: anything else touching the cart refreshes the row, so a
     * cart staled minutes earlier may well be back in sync by the time the Resolver looks.
     */
    async function staleTheCartTotals(): Promise<void> {
      await post(`/customers/${ava.id}/cart/items`, { productId: mug });
      await post(`/customers/${ava.id}/cart/items`, { productId: tee });
      const removal = await fetch(`${shopliteApi}/customers/${ava.id}/cart/items/${tee}`, {
        method: "DELETE",
      });
      expect(removal.ok).toBe(true);

      const { rows } = await admin.$client.query<{ item_count: number; lines: number }>(
        `SELECT t.item_count, coalesce(sum(i.quantity), 0)::int AS lines
           FROM shoplite.carts c
           JOIN shoplite.cart_totals t ON t.cart_id = c.id
           LEFT JOIN shoplite.cart_items i ON i.cart_id = c.id
          WHERE c.customer_id = $1 AND c.status = 'open'
          GROUP BY t.item_count`,
        [ava.id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.item_count).not.toBe(rows[0]?.lines);
    }

    /** Loki indexes asynchronously; without this the Log Investigator can outrun the line it needs. */
    async function waitForDeclineLine(tools: StructuredTool[]): Promise<void> {
      const [searchLogs] = selectTools(tools, ["search_logs"]);
      if (!searchLogs) throw new Error("search_logs not loaded");
      await pollUntil("the decline line in Loki", async () => {
        const found = String(await searchLogs.invoke({ traceId: declinedTraceId }));
        return found.includes("declined") ? true : undefined;
      });
    }

    it("answers the images-not-loading Ticket from the clear cache article without an Investigator", async () => {
      const { report } = await run("images-not-loading");

      expect(report.verdict.outcome).toBe("answered");
      expect(report.verdict.category).toBe("question");
      expect(report.subagentsInvoked).toEqual([TRIAGE]);
      expect(report.fastPath).toBe(true);
      expect(report.parallelInvestigation).toBe(false);
      expect(report.triage?.helpArticleIds).toContain("40000000-0000-4000-8000-000000000001");
      expect(report.verdict.reply).toMatch(/refresh|cache/i);
      expect(report.warnings).toEqual([]);
    });

    it("cites the trace id and the decline log line on the declined-card Ticket", async () => {
      const ticket = await readTicket(fixture("declined-card"));
      const mcp = createMcpClient(ticket);
      clients.push(mcp);
      await waitForDeclineLine(await mcp.getTools());

      const { report } = await run("declined-card");

      expect(report.verdict.outcome).toBe("answered");
      expect(report.verdict.category).toBe("user_error");
      expect(report.subagentsInvoked).toEqual(
        expect.arrayContaining([LOG_INVESTIGATOR, DATA_INVESTIGATOR, INCIDENT_HISTORIAN]),
      );
      expect(report.parallelInvestigation).toBe(true);
      expect(report.fastPath).toBe(false);

      const evidence = evidenceText(report.verdict.evidence);
      expect(evidence).toMatch(traceIdPattern);
      expect(evidence).toMatch(/declin/i);
      expect(evidence).toMatch(/log|loki|trace/i);
      expect(report.verdict.evidence.some((item) => /payments/i.test(item.provenance))).toBe(true);

      // The Reply goes to a customer: no SQL, no table names, no trace ids.
      expect(report.verdict.reply).toMatch(/declin/i);
      expect(report.verdict.reply).not.toMatch(/shoplite\.payments|SELECT/);
      expect(report.verdict.reply).not.toMatch(traceIdPattern);
    });

    it("cites the seeded Incident and runs its documented data fix once approved", async () => {
      await staleTheCartTotals();

      const { report, applied } = await run("stale-cart-total");

      expect(report.verdict.category).toBe("data_issue");
      expect(report.subagentsInvoked).toEqual(
        expect.arrayContaining([LOG_INVESTIGATOR, DATA_INVESTIGATOR, INCIDENT_HISTORIAN]),
      );
      expect(report.parallelInvestigation).toBe(true);

      // The knowledge loop: one of the three cart_totals Incidents, not the discount red herring.
      const evidence = evidenceText(report.verdict.evidence);
      const cartTotalsIncidents = [
        seedIncidentIds.staleCartTotal,
        ...seedIncidentIds.staleCartTotalDuplicates,
      ];
      expect(cartTotalsIncidents.some((id) => evidence.includes(id))).toBe(true);
      expect(evidence).not.toContain(seedIncidentIds.redHerring);

      // The documented fix, taken to the gate rather than invented. mcp-database sets the
      // search path, so the statement may or may not qualify the schema.
      expect(applied).toHaveLength(1);
      expect(applied[0]).toMatch(/^\s*UPDATE\s+(shoplite\.)?cart_totals/i);

      // Demo moment 2: the Reviewer approved, the row was corrected, and the Verdict says so.
      expect(report.verdict.outcome).toBe("data_fixed");
      const { rows } = await admin.$client.query<{ item_count: number; lines: number }>(
        `SELECT t.item_count, coalesce(sum(i.quantity), 0)::int AS lines
           FROM shoplite.carts c
           JOIN shoplite.cart_totals t ON t.cart_id = c.id
           LEFT JOIN shoplite.cart_items i ON i.cart_id = c.id
          WHERE c.customer_id = $1 AND c.status = 'open'
          GROUP BY t.item_count`,
        [ava.id],
      );
      expect(rows[0]?.item_count).toBe(rows[0]?.lines);
    });
  },
  600_000,
);
