import { type Config, type Ticket, type Verdict, verdictSchema } from "@incident-resolver/shared";
import type { Callbacks } from "@langchain/core/callbacks/manager";
import { type BaseMessage, HumanMessage } from "@langchain/core/messages";
import type { StructuredTool } from "@langchain/core/tools";
import type { StreamEvent } from "@langchain/core/tracers/log_stream";
import { type BaseCheckpointSaver, Command } from "@langchain/langgraph";
import { createDeepAgent } from "deepagents";
import type { ActionRequest, Decision, HITLResponse, InterruptOnConfig } from "langchain";
import { toolStrategy } from "langchain";
import { createProcedureGuard } from "./guard";
import type { Models } from "./models";
import { applyConfidencePolicy, investigationWarnings, isFastPath, ranInParallel } from "./policy";
import { type Prompts, promptVersions } from "./prompts";
import { summarizeRun } from "./run-summary";
import type { Triage } from "./schemas";
import {
  createDataInvestigatorSubagent,
  createIncidentHistorianSubagent,
  createLogInvestigatorSubagent,
  createTriageSubagent,
  investigators,
} from "./subagents";
import { createToolErrorGuard } from "./tool-errors";
import { createWriteTools, type WriteEffects } from "./write-tools";

export type ResolverOptions = {
  config: Config;
  models: Models;
  /** Every tool the MCP client loaded; each subagent picks its own by name. */
  tools: StructuredTool[];
  /** The prompts for this run, resolved once from Langfuse or the repository. */
  prompts: Prompts;
  checkpointer: BaseCheckpointSaver;
  /** What happens when one of the Resolver's writes is approved. */
  writeEffects: WriteEffects;
  /** Which of those writes stop for a Reviewer first, from `interruptsFor(ticket)`. */
  interruptOn: Record<string, InterruptOnConfig>;
};

/**
 * Graph steps a run may take before LangGraph stops it. Each model turn and each tool batch
 * is one step; a fan-out to all three Investigators is still one step, so this slice needs
 * about a dozen. Sixty leaves room for corrected SQL and a second log search without letting
 * a confused run loop until the wall-clock timeout in config.
 */
const RECURSION_LIMIT = 60;

/**
 * The orchestrating deep agent. Triage and the three Investigators are subagents reached
 * through the task tool, which runs them concurrently when the Resolver asks for them in one
 * turn. The procedure guard keeps delegations in order and hands each Investigator Triage's
 * hypothesis as focus, and the run ends with a Verdict in the Zod response format.
 *
 * The Resolver's own tools are the writes, and every one of them is behind the gate: the graph
 * interrupts before the tool runs, and only a Reviewer's Decision lets it through. The
 * checkpointer is what makes that possible, since a paused thread is resumed from it.
 */
export function createResolver({
  config,
  models,
  tools,
  prompts,
  checkpointer,
  writeEffects,
  interruptOn,
}: ResolverOptions) {
  const investigator = { model: models.investigator, tools, prompts };
  return createDeepAgent({
    name: "resolver",
    model: models.resolver,
    systemPrompt: prompts.text("resolver"),
    tools: createWriteTools(writeEffects),
    interruptOn,
    subagents: [
      createTriageSubagent({ model: models.triage, tools, prompts }),
      createLogInvestigatorSubagent(investigator),
      createDataInvestigatorSubagent(investigator),
      createIncidentHistorianSubagent(investigator),
    ],
    // The error guard is outermost: an Investigator that dies comes back as a task tool error
    // the Resolver can decide around, rather than ending the run.
    middleware: [createToolErrorGuard(), createProcedureGuard(config.confidenceThreshold)],
    responseFormat: toolStrategy(verdictSchema),
    checkpointer,
  });
}

export type Resolver = ReturnType<typeof createResolver>;

/** The Ticket as the Resolver reads it. */
export function renderTicket(ticket: Ticket): string {
  const lines = [
    `# Ticket ${ticket.id}`,
    `Source: ${ticket.source}`,
    ticket.reporterEmail ? `Reporter: ${ticket.reporterEmail}` : undefined,
    ticket.traceId ? `ShopLite trace id: ${ticket.traceId}` : undefined,
    "",
    `## ${ticket.title}`,
    "",
    ticket.body,
  ];
  return lines.filter((line) => line !== undefined).join("\n");
}

/**
 * The LangGraph thread one run of a Ticket is checkpointed under: the Ticket id and the run
 * number. Derived rather than remembered, because a run that pauses at the approval gate is
 * resumed minutes later by a different request, which must reach the same thread; a re-run is
 * a new run number and so a fresh thread, which is what leaves the earlier one intact.
 *
 * This is the portal's, which counts a Ticket's runs. A caller with no run number of its own
 * wants `freshThreadId`, or the same Ticket resolved twice would carry on where it left off.
 */
export function defaultThreadId(ticket: Pick<Ticket, "id">, run: number): string {
  return `${ticket.id}:run-${run}`;
}

/** A thread no earlier run can be sitting on: for a one-off run, such as one from the CLI. */
export function freshThreadId(ticket: Pick<Ticket, "id">, now = new Date()): string {
  return `${ticket.id}:${now.toISOString()}`;
}

/** What one Resolver run produced and did. */
export type RunReport = {
  ticketId: string;
  threadId: string;
  verdict: Verdict;
  triage: Triage | undefined;
  subagentsInvoked: string[];
  /** Answered from a Help article after Triage alone, with no Investigator run. */
  fastPath: boolean;
  /** All three Investigators were launched in one turn, so their spans overlap in the trace. */
  parallelInvestigation: boolean;
  /** Which version of each prompt this run used: `langfuse v3`, or `file`. */
  prompts: Record<string, string>;
  /** Ways the run departed from the procedure, for whoever runs the Resolver rather than the Reporter. */
  warnings: string[];
};

export type ResolveOptions = {
  resolver: Resolver;
  ticket: Ticket;
  /** The LangGraph thread the checkpointer stores this run under. */
  threadId: string;
  config: Config;
  prompts: Prompts;
  callbacks?: Callbacks;
  /** Abandons the run. Defaults to the run timeout from config, which is what the CLI wants. */
  signal?: AbortSignal;
};

/** What the graph leaves behind: the run's messages, and the Verdict in its response format. */
type FinalState = { messages: BaseMessage[]; structuredResponse?: unknown };

const agentInput = (ticket: Ticket) => ({ messages: [new HumanMessage(renderTicket(ticket))] });

const runConfig = ({ threadId, config, callbacks, signal }: ResolveOptions) => ({
  configurable: { thread_id: threadId },
  callbacks,
  recursionLimit: RECURSION_LIMIT,
  signal: signal ?? AbortSignal.timeout(config.runTimeoutMs),
});

/**
 * Where a run stopped. A run either reaches its Verdict or stops at the gate holding one or
 * more Proposals; a caller with no way to decide on them must treat a pause as unfinished
 * work, not as a failure.
 */
export type RunOutcome =
  | { status: "finished"; report: RunReport }
  | { status: "paused"; proposals: ActionRequest[] };

export type StreamTicketOptions = ResolveOptions & {
  /**
   * Every LangChain event the run produces, as it happens, nested subagent runs included.
   * This is what the portal turns into timeline entries. A caller that only wants the Verdict
   * leaves it out.
   */
  onEvent?: (event: StreamEvent) => void;
};

/** Runs the Resolver on one Ticket and reports its Verdict, or the Proposal it stopped at. */
export function resolveTicket(options: ResolveOptions): Promise<RunOutcome> {
  return streamTicket(options);
}

/**
 * The same run, reported as it goes rather than only at the end. The final state arrives as
 * the `on_chain_end` of the outermost run, which is the run every other event descends from,
 * so the Verdict is read from the stream itself.
 */
export function streamTicket(options: StreamTicketOptions): Promise<RunOutcome> {
  return streamFrom(agentInput(options.ticket), options);
}

/**
 * Carries a paused run on with the Reviewer's Decisions, in the order the Proposals were
 * raised. The thread is the one the run paused on, so everything it had gathered is still
 * there: this is a continuation of the same run, not a new one.
 */
export function resumeTicket(
  options: StreamTicketOptions,
  decisions: Decision[],
): Promise<RunOutcome> {
  const response: HITLResponse = { decisions };
  return streamFrom(new Command({ resume: response }), options);
}

/** What the graph takes in: a first message, or a Command resuming a paused thread. */
type AgentInput = Parameters<Resolver["streamEvents"]>[0];

async function streamFrom(input: AgentInput, options: StreamTicketOptions): Promise<RunOutcome> {
  const { resolver, onEvent } = options;
  const stream = resolver.streamEvents(input, { ...runConfig(options), version: "v2" });
  let rootRunId: string | undefined;
  let finalState: FinalState | undefined;
  for await (const event of stream) {
    rootRunId ??= event.run_id;
    if (event.event === "on_chain_end" && event.run_id === rootRunId) {
      finalState = event.data.output as FinalState;
    }
    onEvent?.(event);
  }
  return outcomeOf(finalState, options);
}

/**
 * What the run left behind. The graph's own state is what says whether it stopped at the gate:
 * a pause leaves the interrupted tasks pending on the thread, each carrying the Proposals the
 * Reviewer is being asked about, and a finished run leaves none.
 */
async function outcomeOf(
  finalState: FinalState | undefined,
  options: StreamTicketOptions | ResolveOptions,
): Promise<RunOutcome> {
  const proposals = await pendingProposals(options);
  if (proposals.length > 0) return { status: "paused", proposals };
  if (!finalState) throw new Error("The Resolver stream ended without a final state");
  return { status: "finished", report: reportFor(finalState, options) };
}

/**
 * As much of a LangGraph state snapshot as the gate reads. Declared here because the deep
 * agent's `getState` resolves to `never` through its generics, so the graph's own shape is
 * not available to us at the type level.
 */
type PendingTasks = { tasks: ReadonlyArray<{ interrupts: ReadonlyArray<{ value?: unknown }> }> };

/** Everything the gate is holding on this thread, oldest first. */
async function pendingProposals({ resolver, threadId }: ResolveOptions): Promise<ActionRequest[]> {
  const snapshot = (await resolver.getState({
    configurable: { thread_id: threadId },
  })) as unknown as PendingTasks;
  return snapshot.tasks.flatMap((task) =>
    task.interrupts.flatMap((interrupt) => actionRequestsOf(interrupt.value)),
  );
}

/** The action requests of one interrupt, which the human-in-the-loop middleware raises as a HITLRequest. */
function actionRequestsOf(value: unknown): ActionRequest[] {
  if (typeof value !== "object" || value === null) return [];
  const requests = (value as { actionRequests?: unknown }).actionRequests;
  return Array.isArray(requests) ? (requests as ActionRequest[]) : [];
}

/** What one finished run produced, read back off its final state. */
function reportFor(result: FinalState, options: ResolveOptions): RunReport {
  const { ticket, threadId, config, prompts } = options;
  const parsed = verdictSchema.safeParse(result.structuredResponse);
  if (!parsed.success) {
    throw new Error(`The Resolver did not end with a Verdict: ${parsed.error.message}`);
  }
  const verdict = applyConfidencePolicy(parsed.data, config.confidenceThreshold);
  const summary = summarizeRun(result.messages);
  const { triage, subagentsInvoked } = summary;
  const investigated = investigators.some((name) => subagentsInvoked.includes(name));
  const qualifiedForFastPath =
    triage !== undefined && isFastPath(triage, config.confidenceThreshold);

  const warnings: string[] = [];
  if (triage === undefined) {
    warnings.push("The Resolver did not run Triage, or Triage returned no structured output");
  }
  warnings.push(...investigationWarnings(summary));
  if (verdict.outcome !== parsed.data.outcome) {
    warnings.push(
      `Confidence ${verdict.confidence} is below the threshold ${config.confidenceThreshold}: outcome ${parsed.data.outcome} was escalated`,
    );
  }

  return {
    ticketId: ticket.id,
    threadId,
    verdict,
    triage,
    subagentsInvoked,
    fastPath: qualifiedForFastPath && !investigated && verdict.outcome === "answered",
    parallelInvestigation: ranInParallel(summary),
    prompts: promptVersions(prompts),
    warnings,
  };
}
