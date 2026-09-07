import type { Config } from "@incident-resolver/shared";
import { ChatOpenAI } from "@langchain/openai";

/**
 * One chat model per role, named in config so any of them can be swapped without touching
 * agent code. gpt-5.4 where the agent reasons and decides, gpt-5.4-mini where it gathers
 * evidence or follows a fixed procedure. The key is a secret, so the caller reads it from
 * the environment and passes it in, the way mcp-incidents does with its Cohere key.
 */
export type Models = {
  resolver: ChatOpenAI;
  triage: ChatOpenAI;
  investigator: ChatOpenAI;
  codeRca: ChatOpenAI;
  fixShipper: ChatOpenAI;
};

export function createModels(config: Config, apiKey: string): Models {
  const model = (name: string) => new ChatOpenAI({ model: name, apiKey });
  return {
    resolver: model(config.models.resolver),
    triage: model(config.models.triage),
    investigator: model(config.models.investigator),
    codeRca: model(config.models.codeRca),
    fixShipper: model(config.models.fixShipper),
  };
}
