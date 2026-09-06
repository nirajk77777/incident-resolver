import { resolve as resolvePath } from "node:path";
import { messageOf } from "@incident-resolver/shared";
import { getConfig } from "@incident-resolver/shared/config";
import type { Callbacks } from "@langchain/core/callbacks/manager";
import type { ActionRequest, Decision } from "langchain";
import { createCheckpointer } from "./checkpointer";
import { parseArgs, readTicket } from "./cli-args";
import { interruptsFor } from "./interrupts";
import { createPromptClient, langfusePromptFetcher } from "./langfuse-prompts";
import { createMcpClient } from "./mcp";
import { createModels } from "./models";
import { promptVersions, resolvePrompts } from "./prompts";
import {
  createResolver,
  freshThreadId,
  type RunStop,
  resolveTicket,
  resumeTicket,
} from "./resolver";
import { startTracing, traceRun } from "./tracing";
import { workspaceStoreFor } from "./workspace";
import { SEND_CUSTOMER_REPLY, type WriteEffects } from "./write-tools";

/**
 * Runs the Resolver on one Ticket from the command line and prints the Verdict as JSON on
 * stdout. Progress and the MCP servers' own startup lines go to stderr, so the output can be
 * piped. Needs the compose stack, a migrated and seeded ShopLite, seeded Help articles, and
 * OPENAI_API_KEY and COHERE_API_KEY. The Langfuse keys are optional and enable tracing and
 * prompt management. Keys are secrets and come straight from the environment; every tunable
 * comes from config.
 */
const log = (line: string) => console.error(line);

function requireEnv(name: string, why: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set; ${why}`);
  return value;
}

const NO_REVIEWER =
  "There is no Reviewer on a command-line run, so this cannot be approved and nothing was " +
  "changed. Put the statement you would have run in the Verdict's Evidence and escalate.";

/**
 * How a run with nobody watching answers the gate. A Reply is only logged here, so approving
 * it writes nothing and lets the run finish; anything that would touch ShopLite data or GitHub
 * is refused with a reason the Resolver can act on. Approving a write from a shell is exactly
 * the thing the gate exists to prevent, so the portal is the only place it can happen.
 */
function unattended(request: ActionRequest): Decision {
  if (request.name === SEND_CUSTOMER_REPLY) return { type: "approve" };
  return { type: "reject", message: NO_REVIEWER };
}

/** Write effects for a run with no Reviewer: the Reply is logged, and nothing else runs. */
const unattendedEffects: WriteEffects = {
  async applyDataFix() {
    return NO_REVIEWER;
  },
  async sendCustomerReply({ text }) {
    log(`Reply (not delivered; delivery is a stub):\n${text}`);
    return `The Reply was recorded as written: ${text}`;
  },
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // pnpm runs package scripts from the package directory; INIT_CWD is where the user typed the command.
  const ticketPath =
    args.ticketPath === "-"
      ? "-"
      : resolvePath(process.env.INIT_CWD ?? process.cwd(), args.ticketPath);
  const ticket = await readTicket(ticketPath);
  const openAiApiKey = requireEnv("OPENAI_API_KEY", "the agents call OpenAI models");
  requireEnv("COHERE_API_KEY", "mcp-incidents embeds Help article searches through Cohere");

  const config = getConfig();
  const langfuse = {
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: process.env.LANGFUSE_SECRET_KEY,
    baseUrl: config.infra.langfuseBaseUrl,
  };
  const tracing = startTracing(langfuse);
  log(
    tracing.enabled
      ? `Tracing to Langfuse at ${config.infra.langfuseBaseUrl}, session ${ticket.id}`
      : "Tracing disabled: set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY to trace this run",
  );

  const promptClient = createPromptClient(langfuse);
  const prompts = await resolvePrompts({
    label: config.infra.langfusePromptLabel,
    variables: { confidenceThreshold: config.confidenceThreshold },
    fetch: promptClient ? langfusePromptFetcher(promptClient) : undefined,
    onFallback: (name, reason) => log(`Prompt ${name} came from its file: ${reason}`),
  });
  log(
    `Prompts (label ${prompts.label}): ` +
      Object.entries(promptVersions(prompts))
        .map(([name, version]) => `${name} ${version}`)
        .join(", "),
  );

  const mcp = createMcpClient(ticket);
  const checkpointer = await createCheckpointer(config);
  const startedAt = Date.now();
  try {
    const tools = await mcp.getTools();
    log(`MCP tools loaded: ${tools.map((tool) => tool.name).join(", ")}`);

    const models = createModels(config, openAiApiKey);
    // Code RCA works in a throwaway clone and writes nothing outside it, so a run with no
    // Reviewer can still have a Workspace: it is only the gated writes a shell must not approve.
    const workspaces = workspaceStoreFor(config, log);
    const resolver = createResolver({
      config,
      models,
      tools,
      prompts,
      checkpointer,
      writeEffects: unattendedEffects,
      interruptOn: interruptsFor(ticket),
      workspace: workspaces.for(ticket.id),
    });
    const threadId = args.threadId ?? freshThreadId(ticket);
    log(`Resolving "${ticket.title}" on thread ${threadId} with ${config.models.resolver}`);

    const run = { resolver, ticket, threadId, config, prompts };
    const trace = (go: (callbacks: Callbacks) => Promise<RunStop>) =>
      traceRun({ ticket, models: config.models, prompts }, go);

    let stop = await trace((callbacks) => resolveTicket({ ...run, callbacks }));
    while (stop.at === "gate") {
      const asked = stop.proposals;
      log(`The gate stopped the run at ${asked.map((proposal) => proposal.name).join(", ")}`);
      stop = await trace((callbacks) => resumeTicket({ ...run, callbacks }, asked.map(unattended)));
    }
    const { report } = stop;

    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    log(
      `Outcome ${report.verdict.outcome} (${report.verdict.category}, confidence ${report.verdict.confidence}) ` +
        `in ${seconds}s; subagents: ${report.subagentsInvoked.join(", ") || "none"}; ` +
        `fast path: ${report.fastPath ? "yes" : "no"}; ` +
        `Investigators in parallel: ${report.parallelInvestigation ? "yes" : "no"}`,
    );
    for (const warning of report.warnings) log(`Warning: ${warning}`);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await mcp.close();
    await checkpointer.end();
    await tracing.shutdown();
  }
}

try {
  await main();
} catch (error) {
  log(`resolve failed: ${messageOf(error)}`);
  process.exit(1);
}
