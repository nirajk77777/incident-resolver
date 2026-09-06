import type { Config } from "@incident-resolver/shared";
import { ChatOpenAI } from "@langchain/openai";

/**
 * One chat model per role, named in config so any of them can be swapped without touching
 * agent code. gpt-5.4 where the agent reasons and decides, gpt-5.4-mini where it gathers
 * evidence or follows a fixed procedure. OPENAI_API_KEY comes from the environment.
 */
export type Models = {
  resolver: ChatOpenAI;
  triage: ChatOpenAI;
  investigator: ChatOpenAI;
};

export function createModels(config: Config): Models {
  return {
    resolver: new ChatOpenAI({ model: config.models.resolver }),
    triage: new ChatOpenAI({ model: config.models.triage }),
    investigator: new ChatOpenAI({ model: config.models.investigator }),
  };
}
