import { type Config, type Ticket, type Verdict, verdictSchema } from "@incident-resolver/shared";
import type { Callbacks } from "@langchain/core/callbacks/manager";
import { type BaseMessage, HumanMessage } from "@langchain/core/messages";
import type { StructuredTool } from "@langchain/core/tools";
import type { StreamEvent } from "@langchain/core/tracers/log_stream";
import { type BaseCheckpointSaver, Command } from "@langchain/langgraph";
import { createDeepAgent } from "deepagents";
import type { ActionRequest, Decision, HITLResponse, InterruptOnConfig } from "langchain";
import { toolStrategy } from "langchain";
import { createCodeRcaSubagent, createWorkspaceProvisioner } from "./code-rca";
import { createEscalationTool, escalationRequested } from "./escalate";
import { createFixShipperSubagent } from "./fix-shipper";
import {
  branchNameFor,
  createPullRequestOpener,
  GITHUB_PULL_REQUEST_TOOL,
  type GithubRepo,
  githubToolNames,
} from "./github";
import { createProcedureGuard } from "./guard";
import type { Models } from "./models";
import {
  endingWarnings,
  investigationWarnings,
  isFastPath,
  ranInParallel,
  settleVerdict,
} from "./policy";
import { type Prompts, promptVersions } from "./prompts";
import { summarizeRun } from "./run-summary";
import type { Triage } from "./schemas";
import {
  createDataInvestigatorSubagent,
  createIncidentHistorianSubagent,
  createLogInvestigatorSubagent,
  createTriageSubagent,
  investigators,
  selectTool,
} from "./subagents";
import { createToolErrorGuard } from "./tool-errors";
import type { Workspace } from "./workspace";
import { workspaceBackend, workspaceClosed } from "./workspace-mount";
import { createWriteTools, noGithubOpener, type WriteEffects } from "./write-tools";

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
  /**
   * This Ticket's clone of ShopLite, which is what gives the run a Code RCA subagent. Left out
   * when there is nowhere to clone to — the command line, or a portal with no ShopLite
   * repository configured — and the Resolver then has no Workspace and no subagent to reach it
   * with, which is a run that can describe a code bug but not fix one.
   */
  workspace?: Workspace | undefined;
  /**
   * GitHub, when this run has a token for it. This is what gives the run a Fix Shipper to push
   * the patch with and something for `create_pull_request` to open the pull request on. Left
   * out when no token is configured, and the Resolver can then confirm a code bug but not ship
   * the fix, which is a run that escalates with the patch still in the Workspace.
   */
  github?: GithubOptions | undefined;
};

export type GithubOptions = {
  /** The repository the branch and the pull request are aimed at. */
  repo: GithubRepo;
  /** The branch the pull request is opened against: ShopLite's default branch. */
  base: string;
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
 * checkpointer is what makes that possible, since a paused thread is resumed from it. The one
 * tool beside them is `escalate_to_human`, which writes nothing and so needs no Reviewer.
 */
export function createResolver({
  config,
  models,
  tools,
  prompts,
  checkpointer,
  writeEffects,
  interruptOn,
  workspace,
  github,
}: ResolverOptions) {
  const investigator = { model: models.investigator, tools, prompts };
  // Empty on a run with no Workspace, which is what leaves the Resolver with nothing to
  // delegate a code bug to; the guard is told the same thing so its refusal says so.
  const codeRcaSubagent = workspace
    ? [createCodeRcaSubagent({ model: models.codeRca, prompts, workspace })]
    : [];
  // Shipping a fix needs three things: the Workspace the patch is in, GitHub to push it to,
  // and the GitHub tools actually loaded. The last is checked rather than assumed because
  // GITHUB_MCP_TOOLSETS decides what the remote server exposes: a portal configured without
  // the pull requests toolset would otherwise fail to build a Resolver at all, and a Question
  // answered from a Help article would break on a setting it never touches. Missing any of
  // the three, the run has no Fix Shipper and nothing to open a pull request with, which is
  // the same run a portal with no token has: it escalates with the patch in the Workspace.
  const shipping =
    workspace && github && githubToolNames.every((name) => has(tools, name))
      ? { workspace, github, branch: branchNameFor(workspace.ticketId) }
      : undefined;
  const fixShipperSubagent = shipping
    ? [
        createFixShipperSubagent({
          model: models.fixShipper,
          prompts,
          workspace: shipping.workspace,
          tools,
          repo: shipping.github.repo,
          base: shipping.github.base,
          branch: shipping.branch,
        }),
      ]
    : [];
  // The one call that reaches GitHub, and the only thing behind the gate's create_pull_request.
  const openPullRequest = shipping
    ? createPullRequestOpener({
        tool: selectTool(tools, GITHUB_PULL_REQUEST_TOOL),
        repo: shipping.github.repo,
        base: shipping.github.base,
        branch: shipping.branch,
      })
    : noGithubOpener;
  return createDeepAgent({
    name: "resolver",
    model: models.resolver,
    systemPrompt: prompts.text("resolver"),
    tools: [...createWriteTools(writeEffects, openPullRequest), createEscalationTool()],
    interruptOn,
    // The Workspace is mounted on the agent's filesystem and closed to everyone here: Code RCA
    // declares its own permissions and is the only agent let in (ADR-0002). Without a Workspace
    // the filesystem stays what it was, files in graph state that nothing here uses.
    backend: workspace ? workspaceBackend(workspace) : undefined,
    permissions: workspace ? workspaceClosed : undefined,
    subagents: [
      createTriageSubagent({ model: models.triage, tools, prompts }),
      createLogInvestigatorSubagent(investigator),
      createDataInvestigatorSubagent(investigator),
      createIncidentHistorianSubagent(investigator),
      ...codeRcaSubagent,
      ...fixShipperSubagent,
    ],
    // The error guard is outermost: an Investigator that dies comes back as a task tool error
    // the Resolver can decide around, rather than ending the run. The provisioner is innermost,
    // so a delegation the guard refuses never clones anything.
    middleware: [
      createToolErrorGuard(),
      createProcedureGuard({
        confidenceThreshold: config.confidenceThreshold,
        codeRca: workspace !== undefined,
        fixShipper: shipping !== undefined,
      }),
      ...(workspace ? [createWorkspaceProvisioner(workspace)] : []),
    ],
    responseFormat: toolStrategy(verdictSchema),
    checkpointer,
  });
}

/** Whether the MCP client loaded a tool by this name. */
const has = (tools: StructuredTool[], name: string) => tools.some((tool) => tool.name === name);

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
 * Where a run stopped: at its Verdict, or at the gate holding one or more Proposals. Named
 * away from Outcome and Status, which CONTEXT.md gives to the Ticket. A caller with no way to
 * decide on a Proposal must treat a stop at the gate as unfinished work, not as a failure.
 */
export type RunStop =
  | { at: "verdict"; report: RunReport }
  | { at: "gate"; proposals: ActionRequest[] };

export type StreamTicketOptions = ResolveOptions & {
  /**
   * Every LangChain event the run produces, as it happens, nested subagent runs included.
   * This is what the portal turns into timeline entries. A caller that only wants the Verdict
   * leaves it out.
   */
  onEvent?: (event: StreamEvent) => void;
};

/** Runs the Resolver on one Ticket and reports its Verdict, or the Proposal it stopped at. */
export function resolveTicket(options: ResolveOptions): Promise<RunStop> {
  return streamTicket(options);
}

/**
 * The same run, reported as it goes rather than only at the end. The final state arrives as
 * the `on_chain_end` of the outermost run, which is the run every other event descends from,
 * so the Verdict is read from the stream itself.
 */
export function streamTicket(options: StreamTicketOptions): Promise<RunStop> {
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
): Promise<RunStop> {
  const response: HITLResponse = { decisions };
  return streamFrom(new Command({ resume: response }), options);
}

/** What the graph takes in: a first message, or a Command resuming a paused thread. */
type AgentInput = Parameters<Resolver["streamEvents"]>[0];

async function streamFrom(input: AgentInput, options: StreamTicketOptions): Promise<RunStop> {
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
): Promise<RunStop> {
  const proposals = await pendingProposals(options);
  if (proposals.length > 0) return { at: "gate", proposals };
  if (!finalState) throw new Error("The Resolver stream ended without a final state");
  return { at: "verdict", report: reportFor(finalState, options) };
}

/**
 * As much of a LangGraph state snapshot as the gate reads. Declared here because the deep
 * agent's `getState` resolves to `never` through its generics, so the graph's own shape is
 * not available to us at the type level.
 */
type PendingTasks = { tasks: ReadonlyArray<{ interrupts: ReadonlyArray<{ value?: unknown }> }> };

/**
 * Everything the gate is holding on this thread, oldest first. Exported because the caller
 * resuming a run has to answer every Proposal the graph is waiting on, not only the one a
 * Reviewer looked at: the middleware reads one Decision per request, and a short array leaves
 * the run stranded on the thread.
 */
export async function pendingProposals({
  resolver,
  threadId,
}: ResolveOptions): Promise<ActionRequest[]> {
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
  const summary = summarizeRun(result.messages);
  const ending = {
    confidenceThreshold: config.confidenceThreshold,
    escalationAsked: escalationRequested(result.messages),
  };
  const verdict = settleVerdict(parsed.data, ending);
  const { triage, subagentsInvoked } = summary;
  const investigated = investigators.some((name) => subagentsInvoked.includes(name));
  const qualifiedForFastPath =
    triage !== undefined && isFastPath(triage, config.confidenceThreshold);

  const warnings: string[] = [];
  if (triage === undefined) {
    warnings.push("The Resolver did not run Triage, or Triage returned no structured output");
  }
  warnings.push(...investigationWarnings(summary));
  warnings.push(...endingWarnings(parsed.data, verdict, ending));

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
