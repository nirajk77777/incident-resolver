import {
  createCheckpointer,
  createMcpClient,
  createModels,
  createPromptClient,
  createResolver,
  defaultThreadId,
  interruptsFor,
  type LangfuseCredentials,
  langfusePromptFetcher,
  type Prompts,
  pendingProposals,
  type RunReport,
  type RunStop,
  resolvePrompts,
  resumeTicket,
  startTracing,
  streamTicket,
  traceRun,
} from "@incident-resolver/agents";
import { argumentsOf, type Config, isApprovalAction, type Ticket } from "@incident-resolver/shared";
import type { Callbacks } from "@langchain/core/callbacks/manager";
import type { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type { ActionRequest, Decision } from "langchain";
import { createEventTranslator } from "./agent-events";
import { createEventQueue } from "./queue";
import type { ResolverDecision, ResolverEvent, ResolverRun, TicketResolver } from "./resolver";

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

  /**
   * One pass over the graph: from the Ticket, or from a Reviewer's Decision. Both stream the
   * same way and both can end at the gate, since a run may have more than one write to make.
   */
  async function* pass(
    { ticket, run, effects, signal }: ResolverRun,
    decision: ResolverDecision | undefined,
  ): AsyncGenerator<ResolverEvent> {
    const { prompts, checkpointer } = await load();
    const mcp = createMcpClient(ticket, env);
    const queue = createEventQueue<ResolverEvent>();
    try {
      const tools = await mcp.getTools();
      const resolver = createResolver({
        config,
        models,
        tools,
        prompts,
        checkpointer,
        writeEffects: effects,
        interruptOn: interruptsFor(ticket),
      });
      const translate = createEventTranslator();
      // Derived from the Ticket and the run number, so a run that paused minutes ago is
      // resumed on the thread it paused on, with everything it had gathered still there.
      const threadId = defaultThreadId(ticket, run);
      const options = {
        resolver,
        ticket,
        threadId,
        config,
        prompts,
        signal,
        onEvent: (event: Parameters<ReturnType<typeof createEventTranslator>>[0]) => {
          const entry = translate(event);
          if (entry) queue.push(entry);
        },
      };

      // The graph reads one Decision per Proposal it is holding, and a Reviewer answers one
      // at a time, so every other Proposal in the same batch is refused with a reason that
      // sends the agent back to ask for it on its own. Nothing else could be done with it:
      // the run cannot carry on holding a Proposal the Reviewer has not seen.
      const answers = decision
        ? decisionsFor(await pendingProposals(options), decision)
        : undefined;

      const traced = traceRun(
        {
          ticket,
          models: config.models,
          prompts,
          onTrace: (langfuseTraceId) => queue.push({ type: "trace", langfuseTraceId }),
        },
        (callbacks: Callbacks): Promise<RunStop> =>
          answers
            ? resumeTicket({ ...options, callbacks }, answers)
            : streamTicket({ ...options, callbacks }),
      );
      // However the run ends, the timeline stops with it; a failure is re-thrown by the
      // `await` below, once everything the run did manage to report has been yielded.
      const running = traced.finally(() => queue.close());
      running.catch(() => {});

      for await (const event of queue) yield event;
      const stop = await running;
      if (stop.at === "gate") {
        for (const proposal of stop.proposals) {
          if (!isApprovalAction(proposal.name)) {
            throw new Error(`The run stopped on ${proposal.name}, which is not a gated action`);
          }
          yield { type: "interrupt", action: proposal.name, args: proposal.args };
        }
        return;
      }
      reportRun(ticket, stop.report, log);
      yield { type: "verdict", verdict: stop.report.verdict };
    } finally {
      await mcp.close();
    }
  }

  return {
    name: "real",

    resolve(run: ResolverRun) {
      return pass(run, undefined);
    },

    resume(run: ResolverRun, decision: ResolverDecision) {
      return pass(run, decision);
    },

    async close() {
      const opened = await shared?.catch(() => undefined);
      await opened?.checkpointer.end();
      await tracing.shutdown();
    },
  };
}

/**
 * One Decision per Proposal the graph is holding, in the order it raised them. The Reviewer's
 * answer goes to the first Proposal for the action they answered; anything else the run asked
 * for in the same turn is refused, since nobody has seen it.
 */
export function decisionsFor(pending: ActionRequest[], decision: ResolverDecision): Decision[] {
  let answered = false;
  return pending.map((proposal) => {
    if (!answered && proposal.name === decision.action) {
      answered = true;
      return decisionFor(decision);
    }
    return {
      type: "reject",
      message:
        "A Reviewer answered a different Proposal from this turn. Ask for this one on its own, " +
        "once the run has carried out what they decided.",
    };
  });
}

/**
 * The Reviewer's answer in the terms the human-in-the-loop middleware resumes on. An edit
 * arrives as the arguments of the interrupted call, so the tool runs on the Reviewer's
 * wording; a rejection arrives as the message the agent reads before it decides what to do.
 */
function decisionFor(decision: ResolverDecision): Decision {
  if (decision.decision === "edit" && decision.proposal) {
    return {
      type: "edit",
      editedAction: { name: decision.action, args: argumentsOf(decision.proposal) },
    };
  }
  if (decision.decision === "reject") {
    return { type: "reject", message: decision.reason ?? "A Reviewer rejected this." };
  }
  return { type: "approve" };
}

function reportRun(ticket: Ticket, report: RunReport, log: (line: string) => void): void {
  log(
    `Ticket ${ticket.id}: ${report.verdict.outcome} (${report.verdict.category}, ` +
      `confidence ${report.verdict.confidence}); subagents: ${report.subagentsInvoked.join(", ") || "none"}`,
  );
  for (const warning of report.warnings) log(`Ticket ${ticket.id}: ${warning}`);
}
