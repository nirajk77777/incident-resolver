import type { LanguageModelLike } from "@langchain/core/language_models/base";
import type { StructuredTool } from "@langchain/core/tools";
import type { SubAgent } from "deepagents";
import { toolStrategy } from "langchain";
import type { Prompts } from "./prompts";
import {
  dataInvestigationSchema,
  incidentSearchSchema,
  logInvestigationSchema,
  triageSchema,
} from "./schemas";
import { createToolErrorGuard } from "./tool-errors";

export const TRIAGE = "triage";
export const LOG_INVESTIGATOR = "log-investigator";
export const DATA_INVESTIGATOR = "data-investigator";
export const INCIDENT_HISTORIAN = "incident-historian";

/** The three Investigators, in the order the Resolver is told to launch them. */
export const investigators = [LOG_INVESTIGATOR, DATA_INVESTIGATOR, INCIDENT_HISTORIAN] as const;

/** Triage's only tool. */
export const triageToolNames = ["search_help_articles"] as const;
/** The mcp-observability tools. */
export const logInvestigatorToolNames = [
  "search_logs",
  "get_trace",
  "query_metrics",
  "get_error_rate",
  "list_recent_errors",
] as const;
/** The mcp-database tools. */
export const dataInvestigatorToolNames = [
  "describe_schema",
  "run_readonly_sql",
  "propose_data_fix",
] as const;
/** The read side of mcp-incidents. `save_incident` is a write at Ticket close, not the Historian's. */
export const incidentHistorianToolNames = ["search_similar_incidents", "get_incident"] as const;

/** Picks the named tools out of everything the MCP client loaded, failing loudly if one is missing. */
export function selectTools(tools: StructuredTool[], names: readonly string[]): StructuredTool[] {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return names.map((name) => {
    const tool = byName.get(name);
    if (!tool) {
      const available =
        tools
          .map((candidate) => candidate.name)
          .sort()
          .join(", ") || "none";
      throw new Error(`MCP tool ${name} is not available; loaded tools: ${available}`);
    }
    return tool;
  });
}

type SubagentOptions = { model: LanguageModelLike; tools: StructuredTool[]; prompts: Prompts };

/** Classifies the Ticket with search_help_articles only, returning structured Triage. */
export function createTriageSubagent({ model, tools, prompts }: SubagentOptions): SubAgent {
  return {
    name: TRIAGE,
    description:
      "Classifies a Ticket: category, severity, component, hypothesis, confidence, and the Help " +
      "articles that answer it. Call it first, with the Ticket text verbatim. It does not investigate.",
    systemPrompt: prompts.text("triage"),
    model,
    tools: selectTools(tools, triageToolNames),
    middleware: [createToolErrorGuard()],
    responseFormat: toolStrategy(triageSchema),
  };
}

/** Gathers Evidence from ShopLite's logs, traces, and metrics through the mcp-observability tools. */
export function createLogInvestigatorSubagent({
  model,
  tools,
  prompts,
}: SubagentOptions): SubAgent {
  return {
    name: LOG_INVESTIGATOR,
    description:
      "Reads ShopLite's telemetry in Loki, Tempo, and Prometheus: the log lines and the trace " +
      "behind the Reporter's request, and whether the route is failing for everyone. Returns an " +
      "Evidence summary with the query behind each fact and the trace ids it saw. Give it the " +
      "Ticket, its trace id if it has one, and what to look for.",
    systemPrompt: prompts.text("log-investigator"),
    model,
    tools: selectTools(tools, logInvestigatorToolNames),
    middleware: [createToolErrorGuard()],
    responseFormat: toolStrategy(logInvestigationSchema),
  };
}

/** Gathers Evidence from ShopLite's database through the mcp-database tools. */
export function createDataInvestigatorSubagent({
  model,
  tools,
  prompts,
}: SubagentOptions): SubAgent {
  return {
    name: DATA_INVESTIGATOR,
    description:
      "Queries ShopLite's database read-only for the Reporter's carts, orders, payments, and " +
      "discount codes, and returns an Evidence summary with the SQL that produced each fact, plus " +
      "a data fix Proposal when a row is wrong. Give it the Ticket, the hypothesis, and what to look for.",
    systemPrompt: prompts.text("data-investigator"),
    model,
    tools: selectTools(tools, dataInvestigatorToolNames),
    middleware: [createToolErrorGuard()],
    responseFormat: toolStrategy(dataInvestigationSchema),
  };
}

/** Searches the knowledge base for past Incidents through the mcp-incidents tools. */
export function createIncidentHistorianSubagent({
  model,
  tools,
  prompts,
}: SubagentOptions): SubAgent {
  return {
    name: INCIDENT_HISTORIAN,
    description:
      "Searches past Incidents for one that matches this Ticket and returns the best matches after " +
      "Cohere rerank, each with its documented root cause and resolution. Use it to reuse a fix " +
      "someone already worked out. Give it the Ticket's symptoms in the Reporter's own words.",
    systemPrompt: prompts.text("incident-historian"),
    model,
    tools: selectTools(tools, incidentHistorianToolNames),
    middleware: [createToolErrorGuard()],
    responseFormat: toolStrategy(incidentSearchSchema),
  };
}
