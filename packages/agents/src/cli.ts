import { resolve as resolvePath } from "node:path";
import { messageOf } from "@incident-resolver/shared";
import { getConfig } from "@incident-resolver/shared/config";
import { createCheckpointer } from "./checkpointer";
import { parseArgs, readTicket } from "./cli-args";
import { createPromptClient, langfusePromptFetcher } from "./langfuse-prompts";
import { createMcpClient } from "./mcp";
import { createModels } from "./models";
import { promptVersions, resolvePrompts } from "./prompts";
import { createResolver, defaultThreadId, resolveTicket } from "./resolver";
import { startTracing, traceRun } from "./tracing";

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
    const resolver = createResolver({ config, models, tools, prompts, checkpointer });
    const threadId = args.threadId ?? defaultThreadId(ticket);
    log(`Resolving "${ticket.title}" on thread ${threadId} with ${config.models.resolver}`);

    const report = await traceRun({ ticket, models: config.models, prompts }, (callbacks) =>
      resolveTicket({ resolver, ticket, threadId, config, prompts, callbacks }),
    );

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
