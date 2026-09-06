import { resolve as resolvePath } from "node:path";
import { getConfig, messageOf } from "@incident-resolver/shared";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { parseArgs, readTicket } from "./cli-args";
import { createMcpClient } from "./mcp";
import { createModels } from "./models";
import { createResolver, resolveTicket } from "./resolver";
import { startTracing, traceRun } from "./tracing";

/**
 * Runs the Resolver on one Ticket from the command line and prints the Verdict as JSON on
 * stdout. Progress and the MCP servers' own startup lines go to stderr, so the output can be
 * piped. Needs the compose stack, a migrated and seeded ShopLite, seeded Help articles,
 * OPENAI_API_KEY and COHERE_API_KEY, and optionally the Langfuse keys for tracing.
 */
const log = (line: string) => console.error(line);

function requireEnv(name: string, why: string): void {
  if (!process.env[name]) throw new Error(`${name} is not set; ${why}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // pnpm runs package scripts from the package directory; INIT_CWD is where the user typed the command.
  const ticketPath =
    args.ticketPath === "-"
      ? "-"
      : resolvePath(process.env.INIT_CWD ?? process.cwd(), args.ticketPath);
  const ticket = await readTicket(ticketPath);
  requireEnv("OPENAI_API_KEY", "the agents call OpenAI models");
  requireEnv("COHERE_API_KEY", "mcp-incidents embeds Help article searches through Cohere");

  const config = getConfig();
  const tracing = startTracing();
  log(
    tracing.enabled
      ? `Tracing to Langfuse, session ${ticket.id}`
      : "Tracing disabled: set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY to trace this run",
  );

  const checkpointer = PostgresSaver.fromConnString(config.infra.databaseUrl, {
    schema: "portal",
  });
  const mcp = createMcpClient(ticket);
  const startedAt = Date.now();
  try {
    await checkpointer.setup();
    const tools = await mcp.getTools();
    log(`MCP tools loaded: ${tools.map((tool) => tool.name).join(", ")}`);

    const resolver = createResolver({ config, models: createModels(config), tools, checkpointer });
    const threadId = args.threadId ?? `${ticket.id}:${new Date().toISOString()}`;
    log(`Resolving "${ticket.title}" on thread ${threadId} with ${config.models.resolver}`);

    const result = await traceRun(ticket, config.models, (callbacks) =>
      resolveTicket({ resolver, ticket, threadId, config, callbacks }),
    );

    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    log(
      `Outcome ${result.verdict.outcome} (${result.verdict.category}, confidence ${result.verdict.confidence}) ` +
        `in ${seconds}s; subagents: ${result.subagentsInvoked.join(", ") || "none"}; ` +
        `fast path: ${result.fastPath ? "yes" : "no"}`,
    );
    for (const warning of result.warnings) log(`Warning: ${warning}`);
    console.log(JSON.stringify(result, null, 2));
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
