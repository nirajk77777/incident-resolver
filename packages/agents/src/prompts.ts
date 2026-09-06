import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Prompts live in the repository as markdown under `packages/agents/prompts/` and are read
 * from disk at startup, so they can be reviewed and diffed like code. `{{name}}` placeholders
 * are filled from config; leaving one unfilled is an error rather than a prompt with a hole.
 */
export const promptNames = ["resolver", "triage", "data-investigator"] as const;
export type PromptName = (typeof promptNames)[number];

export const promptsDir = fileURLToPath(new URL("../prompts/", import.meta.url));

const placeholder = /\{\{\s*(\w+)\s*\}\}/g;

export function loadPrompt(
  name: PromptName,
  variables: Record<string, string | number> = {},
): string {
  const path = `${promptsDir}${name}.md`;
  if (!existsSync(path)) throw new Error(`No prompt named ${name} at ${path}`);
  const template = readFileSync(path, "utf8");
  return template.replace(placeholder, (_match, key: string) => {
    const value = variables[key];
    if (value === undefined) throw new Error(`Prompt ${name} needs a value for {{${key}}}`);
    return String(value);
  });
}
