import { randomUUID } from "node:crypto";
import type { Ticket } from "@incident-resolver/shared";
import { getConfig } from "@incident-resolver/shared/config";
import {
  type Evaluation,
  type Evaluator,
  LangfuseClient,
  type RunEvaluator,
} from "@langfuse/client";
import type { ActionRequest, Decision } from "langchain";
import { createCheckpointer } from "../checkpointer";
import { interruptsFor } from "../interrupts";
import { createPromptClient, langfusePromptFetcher } from "../langfuse-prompts";
import { createMcpClient } from "../mcp";
import { createModels } from "../models";
import { promptVersions, resolvePrompts } from "../prompts";
import {
  createResolver,
  defaultThreadId,
  type RunStop,
  resolveTicket,
  resumeTicket,
} from "../resolver";
import { startTracing, traceRun } from "../tracing";
import { workspaceStoreFor } from "../workspace";
import type { WriteEffects } from "../write-tools";

/**
 * Runs the Resolver over the `incident-resolver/golden` dataset in Langfuse and scores each run.
 *
 *   EVAL_LABEL=production pnpm --filter @incident-resolver/agents eval:resolver
 *   EVAL_LABEL=candidate  pnpm --filter @incident-resolver/agents eval:resolver
 *
 * Every prompt is read under EVAL_LABEL, falling back to `production` for a prompt that has no
 * version under that label, so only the prompts you edited change between the two runs.
 * Every gate is approved and every write is simulated: nothing reaches ShopLite's data or GitHub.
 * Needs the compose stack, ShopLite on SHOPLITE_API_URL (default localhost:4000), and the keys.
 */

const DATASET = "incident-resolver/golden";
const label = process.env.EVAL_LABEL ?? "production";
const shopliteApi = process.env.SHOPLITE_API_URL ?? "http://localhost:4000";
const log = (line: string) => console.error(line);

const config = getConfig();
const openAiApiKey = process.env.OPENAI_API_KEY;
if (!openAiApiKey) throw new Error("OPENAI_API_KEY is not set");
const credentials = {
  publicKey: process.env.LANGFUSE_PUBLIC_KEY,
  secretKey: process.env.LANGFUSE_SECRET_KEY,
  baseUrl: config.infra.langfuseBaseUrl,
};

// ---------------------------------------------------------------------------------------------
// 1. Setup: put each planted bug into ShopLite before the agent looks at it.
// ---------------------------------------------------------------------------------------------

const AVA = "00000000-0000-4000-8000-000000000001";
const SOFIA = "00000000-0000-4000-8000-000000000005";
const PRODUCT = {
  mug: "00000000-0000-4000-9000-000000000001",
  poster: "00000000-0000-4000-9000-000000000002",
  candle: "00000000-0000-4000-9000-000000000005",
  tote: "00000000-0000-4000-9000-000000000006",
};
const DECLINED_CARD = { number: "4000000000000002", expMonth: 12, expYear: 2030 };
const GOOD_CARD = { number: "4242424242424242", expMonth: 12, expYear: 2030 };

async function shop(method: string, path: string, body?: unknown) {
  const response = await fetch(`${shopliteApi}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    traceId: response.headers.get("x-trace-id") ?? undefined,
    json: (await response.json().catch(() => null)) as Record<string, unknown> | null,
  };
}

async function emptyCart(customer: string): Promise<void> {
  const cart = await shop("GET", `/customers/${customer}/cart`);
  const items = (cart.json?.items ?? []) as Array<{ productId: string }>;
  for (const item of items)
    await shop("DELETE", `/customers/${customer}/cart/items/${item.productId}`);
  await shop("DELETE", `/customers/${customer}/cart/discount`);
}

const add = (customer: string, productId: string, quantity = 1) =>
  shop("POST", `/customers/${customer}/cart/items`, { productId, quantity });

/** Returns the ShopLite trace id of the failing request, when the scenario has one. */
async function setUp(scenario: string): Promise<string | undefined> {
  switch (scenario) {
    case "none":
      return undefined;
    case "stale-cart": {
      await emptyCart(AVA);
      await add(AVA, PRODUCT.mug);
      await add(AVA, PRODUCT.poster);
      await shop("DELETE", `/customers/${AVA}/cart/items/${PRODUCT.poster}`);
      return undefined;
    }
    case "declined-card": {
      await emptyCart(AVA);
      await add(AVA, PRODUCT.tote);
      return (await shop("POST", `/customers/${AVA}/checkout`, { card: DECLINED_CARD })).traceId;
    }
    case "double-discount": {
      await emptyCart(AVA);
      await add(AVA, PRODUCT.mug, 2);
      await add(AVA, PRODUCT.candle);
      await shop("POST", `/customers/${AVA}/cart/discount`, { code: "SALE10" });
      return (await shop("POST", `/customers/${AVA}/checkout`, { card: GOOD_CARD })).traceId;
    }
    case "empty-cart": {
      await emptyCart(SOFIA);
      return (await shop("POST", `/customers/${SOFIA}/checkout`, { card: GOOD_CARD })).traceId;
    }
    default:
      throw new Error(`Unknown setup scenario: ${scenario}`);
  }
}

// ---------------------------------------------------------------------------------------------
// 2. The task: run the Resolver on one item, approving every gate with simulated writes.
// ---------------------------------------------------------------------------------------------

type Input = { ticket: Omit<Ticket, "id">; setup: string };
type Expected = {
  category: string;
  action: "none" | "apply_data_fix" | "code-rca";
  fastPath: boolean;
  /** How the Ticket may end. More than one when the harness can't reach the portal's ending. */
  outcomes?: string[];
  /** The defect's cause is in the code, so the run should go after it too. */
  codeCause?: boolean;
  /** The files a correct root cause may name: one, or several when the fix can live in either. */
  rcaFile?: string | string[];
};

const SIMULATED = "(Simulated in an evaluation run: nothing was written.)";
const simulatedEffects: WriteEffects = {
  async applyDataFix() {
    return `The fix ran. 1 row(s) were corrected, and the rows as they were have been kept so it can be undone. ${SIMULATED}`;
  },
  async sendCustomerReply({ text }) {
    return `Sent. The Reporter will read exactly this: ${text}`;
  },
  async createPullRequest(_request, opened) {
    return opened.ok
      ? `The pull request is open at ${opened.url}.`
      : `The pull request was not opened. ${opened.reason}`;
  },
};
const approve = (_request: ActionRequest): Decision => ({ type: "approve" });

// Every prompt under the label being tested, or production when it has no version there.
const promptClient = createPromptClient(credentials);
if (!promptClient) throw new Error("Set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY");
const fetchUnderLabel = langfusePromptFetcher(promptClient);
const fetchPrompt: typeof fetchUnderLabel = async (name, wanted) =>
  (await fetchUnderLabel(name, wanted)) ??
  (wanted === "production" ? undefined : fetchUnderLabel(name, "production"));

const tracing = startTracing(credentials);
const models = createModels(config, openAiApiKey);
const workspaces = workspaceStoreFor(config, log);
const checkpointer = await createCheckpointer(config);

async function task(item: { input?: unknown }) {
  // Dataset items come back from Langfuse untyped; the shape is the one the dataset was created with.
  const input = item.input as Input | undefined;
  if (!input) throw new Error("A dataset item has no input");
  const traceId = await setUp(input.setup);
  const ticket: Ticket = { ...input.ticket, id: randomUUID(), ...(traceId ? { traceId } : {}) };
  const prompts = await resolvePrompts({
    label,
    variables: { confidenceThreshold: config.confidenceThreshold },
    fetch: fetchPrompt,
    onFallback: (name, reason) => log(`Prompt ${name} came from its file: ${reason}`),
  });
  const mcp = createMcpClient(ticket);
  const startedAt = Date.now();
  try {
    const resolver = createResolver({
      config,
      models,
      tools: await mcp.getTools(),
      prompts,
      checkpointer,
      writeEffects: simulatedEffects,
      interruptOn: interruptsFor(ticket),
      workspace: workspaces.for(ticket.id),
    });
    const run = { resolver, ticket, threadId: defaultThreadId(ticket, 1), config, prompts };
    const trace = (go: Parameters<typeof traceRun>[1]) =>
      traceRun({ ticket, models: config.models, prompts }, go);

    const proposals: string[] = [];
    let stop: RunStop = await trace((callbacks) => resolveTicket({ ...run, callbacks }));
    while (stop.at === "gate") {
      const asked = stop.proposals;
      proposals.push(...asked.map((proposal) => proposal.name));
      stop = await trace((callbacks) => resumeTicket({ ...run, callbacks }, asked.map(approve)));
    }
    const { report } = stop;
    return {
      verdict: report.verdict,
      triage: report.triage,
      subagentsInvoked: report.subagentsInvoked,
      fastPath: report.fastPath,
      parallelInvestigation: report.parallelInvestigation,
      warnings: report.warnings,
      prompts: promptVersions(prompts),
      proposals,
      seconds: Math.round((Date.now() - startedAt) / 1000),
    };
  } finally {
    await mcp.close();
  }
}

// ---------------------------------------------------------------------------------------------
// 3. Evaluators: plain code over the run's output, one score each.
// ---------------------------------------------------------------------------------------------

type Output = Awaited<ReturnType<typeof task>>;
type Eval = Evaluator<Input, Expected>;
const score = (name: string, passed: boolean, comment?: string): Evaluation => ({
  name,
  value: passed ? 1 : 0,
  dataType: "BOOLEAN",
  ...(comment ? { comment } : {}),
});

const categoryCorrect: Eval = async ({ output, expectedOutput }) => {
  const got = (output as Output).verdict.category;
  return score(
    "category_correct",
    got === expectedOutput?.category,
    `expected ${expectedOutput?.category}, got ${got}`,
  );
};

const actionCorrect: Eval = async ({ output, expectedOutput }) => {
  const run = output as Output;
  const proposedFix = run.proposals.includes("apply_data_fix");
  const ranCodeRca = run.subagentsInvoked.includes("code-rca");
  const passed =
    expectedOutput?.action === "apply_data_fix"
      ? proposedFix
      : expectedOutput?.action === "code-rca"
        ? ranCodeRca
        : !proposedFix && !ranCodeRca;
  return score(
    "action_correct",
    passed,
    `proposals: ${run.proposals.join(", ") || "none"}; code-rca: ${ranCodeRca}`,
  );
};

const codeCausePursued: Eval = async ({ output, expectedOutput }) => {
  if (!expectedOutput?.codeCause) return [];
  return score("code_cause_pursued", (output as Output).subagentsInvoked.includes("code-rca"));
};

const rcaFileCorrect: Eval = async ({ output, expectedOutput }) => {
  if (!expectedOutput?.rcaFile) return [];
  const files = [expectedOutput.rcaFile].flat();
  const { verdict } = output as Output;
  const text = `${verdict.rootCause} ${JSON.stringify(verdict.evidence)}`;
  const named = files.filter((file) => text.includes(file));
  return score(
    "rca_file_correct",
    named.length > 0,
    named.length > 0 ? `names ${named.join(", ")}` : `names none of ${files.join(", ")}`,
  );
};

const outcomeCorrect: Eval = async ({ output, expectedOutput }) => {
  if (!expectedOutput?.outcomes) return [];
  const { outcome } = (output as Output).verdict;
  return score(
    "outcome_correct",
    expectedOutput.outcomes.includes(outcome),
    `expected ${expectedOutput.outcomes.join(" or ")}, got ${outcome}`,
  );
};

const fastPathCorrect: Eval = async ({ output, expectedOutput }) =>
  score("fast_path_correct", (output as Output).fastPath === expectedOutput?.fastPath);

const investigatorsParallel: Eval = async ({ output, expectedOutput }) => {
  if (expectedOutput?.fastPath) return [];
  return score("investigators_parallel", (output as Output).parallelInvestigation);
};

const passRate: RunEvaluator<Input, Expected> = async ({ itemResults }) => {
  const passed = itemResults.filter((result) =>
    result.evaluations.every((evaluation) => evaluation.value === 1),
  ).length;
  return {
    name: "pass_rate",
    value: itemResults.length === 0 ? 0 : passed / itemResults.length,
    comment: `${passed} of ${itemResults.length} items passed every score`,
  };
};

// ---------------------------------------------------------------------------------------------
// 4. Run it.
// ---------------------------------------------------------------------------------------------

const langfuse = new LangfuseClient(credentials);
try {
  const dataset = await langfuse.dataset.get(DATASET);
  const result = await dataset.runExperiment({
    name: "resolver",
    runName: `resolver @ ${label} ${new Date().toISOString().slice(0, 16)}`,
    description: `Resolver on ${DATASET}, every prompt under "${label}" (production where it has none)`,
    metadata: { promptLabel: label, models: JSON.stringify(config.models) },
    task,
    evaluators: [
      categoryCorrect,
      actionCorrect,
      outcomeCorrect,
      codeCausePursued,
      rcaFileCorrect,
      fastPathCorrect,
      investigatorsParallel,
    ],
    runEvaluators: [passRate],
    maxConcurrency: 1,
  });
  console.log(await result.format());
} finally {
  await checkpointer.end();
  await tracing.shutdown();
  await langfuse.flush();
}
