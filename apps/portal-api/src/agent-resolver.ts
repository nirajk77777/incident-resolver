import {
  createCheckpointer,
  createMcpClient,
  createModels,
  createPromptClient,
  createResolver,
  defaultThreadId,
  type LangfuseCredentials,
  langfusePromptFetcher,
  type Prompts,
  type RunReport,
  resolvePrompts,
  startTracing,
  streamTicket,
  traceRun,
} from "@incident-resolver/agents";
import type { Config, Ticket } from "@incident-resolver/shared";
import type { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { createEventTranslator } from "./agent-events";
import { createEventQueue } from "./queue";
import type { ResolverEvent, ResolverRun, TicketResolver } from "./resolver";

export type NodeEnv = Record<string, string | undefined>;

export type AgentResolverOptions = {
  config: Config;
  /** A secret, so it comes from the environment rather than from config. */
  openAiApiKey: string;
  /** Without both Langfuse keys the run is untraced and the Ticket gets no trace link. */
  langfuse: LangfuseCredentials;
  /** Passed to the MCP servers, which are spawned as child processes. */
  env?: NodeEnv;
  /** Progress and warnings for whoever runs the portal, never for the Reporter. */
  log?: (line: string) => void;
};

/** What every run of this portal shares: the prompts it resolved and its checkpoint store. */
type Shared = { prompts: Prompts; checkpointer: PostgresSaver };

/**
 * The Resolver from `@incident-resolver/agents`, behind the portal's seam. One run is one
 * Ticket: its own MCP servers, scoped to the Reporter, its own LangGraph thread, and its own
 * Langfuse trace. The models, the prompts, and the checkpointer are the portal's and are
 * shared, so a second Ticket does not pay for them again.
 *
 * Every LangChain event the run produces is translated into a timeline entry and pushed onto
 * a queue the generator drains, which is what makes the timeline live: the Reviewer sees a
 * subagent start as it starts, not when the run is over.
 */
export function createAgentResolver({
  config,
  openAiApiKey,
  langfuse,
  env = process.env,
  log = () => {},
}: AgentResolverOptions): TicketResolver {
  const tracing = startTracing(langfuse);
  log(
    tracing.enabled
      ? `Tracing Resolver runs to Langfuse at ${langfuse.baseUrl}`
      : "Tracing disabled: set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY to trace runs",
  );
  const models = createModels(config, openAiApiKey);
  // Resolved on the first Ticket rather than at startup, so the portal listens without waiting
  // on Langfuse or on Postgres, and so a portal that never runs a Ticket opens no pool.
  let shared: Promise<Shared> | undefined;

  async function open(): Promise<Shared> {
    const promptClient = createPromptClient(langfuse);
    const prompts = await resolvePrompts({
      label: config.infra.langfusePromptLabel,
      variables: { confidenceThreshold: config.confidenceThreshold },
      fetch: promptClient ? langfusePromptFetcher(promptClient) : undefined,
      onFallback: (name, reason) => log(`Prompt ${name} came from its file: ${reason}`),
    });
    return { prompts, checkpointer: await createCheckpointer(config) };
  }

  function load(): Promise<Shared> {
    // A start that failed is not remembered: Langfuse or Postgres being down for one Ticket
    // must not leave the portal unable to run any of the ones after it.
    shared ??= open().catch((error: unknown) => {
      shared = undefined;
      throw error;
    });
    return shared;
  }

  return {
    name: "real",

    async *resolve({ ticket, signal }: ResolverRun): AsyncGenerator<ResolverEvent> {
      const { prompts, checkpointer } = await load();
      const mcp = createMcpClient(ticket, env);
      const queue = createEventQueue<ResolverEvent>();
      try {
        const tools = await mcp.getTools();
        const resolver = createResolver({ config, models, tools, prompts, checkpointer });
        const translate = createEventTranslator();
        const threadId = defaultThreadId(ticket);

        const traced = traceRun(
          {
            ticket,
            models: config.models,
            prompts,
            onTrace: (langfuseTraceId) => queue.push({ type: "trace", langfuseTraceId }),
          },
          (callbacks) =>
            streamTicket({
              resolver,
              ticket,
              threadId,
              config,
              prompts,
              callbacks,
              signal,
              onEvent: (event) => {
                const entry = translate(event);
                if (entry) queue.push(entry);
              },
            }),
        );
        // However the run ends, the timeline stops with it; a failure is re-thrown by the
        // `await` below, once everything the run did manage to report has been yielded.
        const running = traced.finally(() => queue.close());
        running.catch(() => {});

        for await (const event of queue) yield event;
        const report = await running;
        reportRun(ticket, report, log);
        yield { type: "verdict", verdict: report.verdict };
      } finally {
        await mcp.close();
      }
    },

    async close() {
      const opened = await shared?.catch(() => undefined);
      await opened?.checkpointer.end();
      await tracing.shutdown();
    },
  };
}

function reportRun(ticket: Ticket, report: RunReport, log: (line: string) => void): void {
  log(
    `Ticket ${ticket.id}: ${report.verdict.outcome} (${report.verdict.category}, ` +
      `confidence ${report.verdict.confidence}); subagents: ${report.subagentsInvoked.join(", ") || "none"}`,
  );
  for (const warning of report.warnings) log(`Ticket ${ticket.id}: ${warning}`);
}
