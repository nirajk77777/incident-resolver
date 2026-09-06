import type { LanguageModelLike } from "@langchain/core/language_models/base";
import type { StructuredTool } from "@langchain/core/tools";
import type { SubAgent } from "deepagents";
import { toolStrategy } from "langchain";
import { loadPrompt } from "./prompts";
import { dataInvestigationSchema, triageSchema } from "./schemas";

export const TRIAGE = "triage";
export const DATA_INVESTIGATOR = "data-investigator";

/** Triage's only tool. */
export const triageToolNames = ["search_help_articles"] as const;
/** The mcp-database tools. */
export const dataInvestigatorToolNames = [
  "describe_schema",
  "run_readonly_sql",
  "propose_data_fix",
] as const;

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

type SubagentOptions = { model: LanguageModelLike; tools: StructuredTool[] };

/** Classifies the Ticket with search_help_articles only, returning structured Triage. */
export function createTriageSubagent({ model, tools }: SubagentOptions): SubAgent {
  return {
    name: TRIAGE,
    description:
      "Classifies a Ticket: category, severity, component, hypothesis, confidence, and the Help " +
      "articles that answer it. Call it first, with the Ticket text verbatim. It does not investigate.",
    systemPrompt: loadPrompt("triage"),
    model,
    tools: selectTools(tools, triageToolNames),
    responseFormat: toolStrategy(triageSchema),
  };
}

/** Gathers Evidence from ShopLite's database through the mcp-database tools. */
export function createDataInvestigatorSubagent({ model, tools }: SubagentOptions): SubAgent {
  return {
    name: DATA_INVESTIGATOR,
    description:
      "Queries ShopLite's database read-only for the Reporter's carts, orders, payments, and " +
      "discount codes, and returns an Evidence summary with the SQL that produced each fact, plus " +
      "a data fix Proposal when a row is wrong. Give it the Ticket, the hypothesis, and what to look for.",
    systemPrompt: loadPrompt("data-investigator"),
    model,
    tools: selectTools(tools, dataInvestigatorToolNames),
    responseFormat: toolStrategy(dataInvestigationSchema),
  };
}
