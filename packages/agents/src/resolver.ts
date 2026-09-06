import { type Config, type Ticket, type Verdict, verdictSchema } from "@incident-resolver/shared";
import type { Callbacks } from "@langchain/core/callbacks/manager";
import { HumanMessage } from "@langchain/core/messages";
import type { StructuredTool } from "@langchain/core/tools";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { createDeepAgent } from "deepagents";
import { toolStrategy } from "langchain";
import type { Models } from "./models";
import { applyConfidencePolicy, isFastPath } from "./policy";
import { loadPrompt } from "./prompts";
import { summarizeRun } from "./run-summary";
import type { Triage } from "./schemas";
import {
  createDataInvestigatorSubagent,
  createTriageSubagent,
  DATA_INVESTIGATOR,
} from "./subagents";

export type ResolverOptions = {
  config: Config;
  models: Models;
  /** Every tool the MCP client loaded; each subagent picks its own by name. */
  tools: StructuredTool[];
  checkpointer: BaseCheckpointSaver;
};

/**
 * The orchestrating deep agent. Triage and the Data Investigator are subagents reached through
 * the task tool; the run ends with a Verdict in the Zod response format.
 */
export function createResolver({ config, models, tools, checkpointer }: ResolverOptions) {
  return createDeepAgent({
    name: "resolver",
    model: models.resolver,
    systemPrompt: loadPrompt("resolver", { confidenceThreshold: config.confidenceThreshold }),
    subagents: [
      createTriageSubagent({ model: models.triage, tools }),
      createDataInvestigatorSubagent({ model: models.investigator, tools }),
    ],
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

export type RunResult = {
  ticketId: string;
  threadId: string;
  verdict: Verdict;
  triage: Triage | undefined;
  subagentsInvoked: string[];
  /** Answered from a Help article with no Investigator run. */
  fastPath: boolean;
  /** Ways the run departed from the procedure, for the operator rather than the Reporter. */
  warnings: string[];
};

export type ResolveOptions = {
  resolver: Resolver;
  ticket: Ticket;
  /** The LangGraph thread the checkpointer stores this run under. */
  threadId: string;
  config: Config;
  callbacks?: Callbacks;
};

/** Runs the Resolver on one Ticket and returns its Verdict with what the run did. */
export async function resolveTicket(options: ResolveOptions): Promise<RunResult> {
  const { resolver, ticket, threadId, config, callbacks } = options;
  const result = await resolver.invoke(
    { messages: [new HumanMessage(renderTicket(ticket))] },
    {
      configurable: { thread_id: threadId },
      callbacks,
      recursionLimit: 60,
      signal: AbortSignal.timeout(config.runTimeoutMs),
    },
  );

  const parsed = verdictSchema.safeParse(result.structuredResponse);
  if (!parsed.success) {
    throw new Error(`The Resolver did not end with a Verdict: ${parsed.error.message}`);
  }
  const verdict = applyConfidencePolicy(parsed.data, config.confidenceThreshold);
  const { triage, subagentsInvoked } = summarizeRun(result.messages);
  const investigated = subagentsInvoked.includes(DATA_INVESTIGATOR);

  const warnings: string[] = [];
  if (triage === undefined)
    warnings.push("The Resolver did not run Triage, or Triage returned no structured output");
  if (triage && isFastPath(triage, config.confidenceThreshold) && investigated) {
    warnings.push(
      "Triage qualified for the fast path but the Resolver ran the Data Investigator anyway",
    );
  }
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
    fastPath: verdict.outcome === "answered" && !investigated,
    warnings,
  };
}
