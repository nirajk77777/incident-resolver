import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { messageOf } from "@incident-resolver/shared";

/**
 * Prompts live in the repository as markdown under `packages/agents/prompts/`, so they can be
 * reviewed and diffed like code, and `pnpm prompts:sync` pushes them to Langfuse prompt
 * management under a label. At runtime `resolvePrompts` fetches each one by name and label and
 * falls back to the file, so startup never depends on the network. `{{name}}` placeholders are
 * filled from config; leaving one unfilled is an error rather than a prompt with a hole.
 */
export const promptNames = [
  "resolver",
  "triage",
  "log-investigator",
  "data-investigator",
  "incident-historian",
  "code-rca",
  "fix-shipper",
] as const;
export type PromptName = (typeof promptNames)[number];

export const promptsDir = fileURLToPath(new URL("../prompts/", import.meta.url));

export type PromptVariables = Record<string, string | number>;

const placeholder = /\{\{\s*(\w+)\s*\}\}/g;

/** The prompt exactly as it sits in the repository, placeholders intact: what the sync pushes. */
export function readPromptFile(name: PromptName): string {
  const path = `${promptsDir}${name}.md`;
  if (!existsSync(path)) throw new Error(`No prompt named ${name} at ${path}`);
  return readFileSync(path, "utf8");
}

/** Fills the `{{placeholders}}` in a prompt, naming the prompt and the variable when one is missing. */
export function fillPlaceholders(
  template: string,
  name: string,
  variables: PromptVariables,
): string {
  return template.replace(placeholder, (_match, key: string) => {
    const value = variables[key];
    if (value === undefined) throw new Error(`Prompt ${name} needs a value for {{${key}}}`);
    return String(value);
  });
}

/** Reads one prompt from the repository and fills it. The fallback when Langfuse has nothing. */
export function loadPrompt(name: PromptName, variables: PromptVariables = {}): string {
  return fillPlaceholders(readPromptFile(name), name, variables);
}

/** One prompt as the run will use it, and which version it is. */
export type ResolvedPrompt = {
  name: PromptName;
  /** Filled and ready for the agent. */
  text: string;
  /** The Langfuse version, or undefined when the local file was used. */
  version: number | undefined;
};

/** Every prompt one run uses, resolved once at startup. */
export type Prompts = {
  /** The Langfuse label the versions were fetched under. */
  label: string;
  /** The filled text of one prompt. */
  text(name: PromptName): string;
  resolved: readonly ResolvedPrompt[];
};

/** Fetches one prompt's raw markdown from Langfuse, or undefined when that label has no version. */
export type PromptFetcher = (
  name: PromptName,
  label: string,
) => Promise<{ text: string; version: number } | undefined>;

export type ResolvePromptsOptions = {
  label: string;
  variables?: PromptVariables;
  /** Omitted when Langfuse is not configured: every prompt then comes from its file. */
  fetch?: PromptFetcher | undefined;
  /** Told why a prompt came from its file instead of Langfuse. The run continues either way. */
  onFallback?: ((name: PromptName, reason: string) => void) | undefined;
};

/**
 * Resolves every prompt once, preferring the Langfuse version under the label and falling back
 * to the repository file whenever Langfuse is unconfigured, has no version under that label,
 * is unreachable, or returns a template this build cannot fill.
 */
export async function resolvePrompts(options: ResolvePromptsOptions): Promise<Prompts> {
  const { label, variables = {}, fetch, onFallback } = options;
  const resolved = await Promise.all(
    promptNames.map((name) => resolveOne(name, label, variables, fetch, onFallback)),
  );
  const byName = new Map(resolved.map((prompt) => [prompt.name, prompt]));
  return {
    label,
    resolved,
    text(name) {
      const prompt = byName.get(name);
      if (!prompt) throw new Error(`Prompt ${name} was not resolved for this run`);
      return prompt.text;
    },
  };
}

async function resolveOne(
  name: PromptName,
  label: string,
  variables: PromptVariables,
  fetch: PromptFetcher | undefined,
  onFallback: ResolvePromptsOptions["onFallback"],
): Promise<ResolvedPrompt> {
  if (fetch) {
    try {
      const fetched = await fetch(name, label);
      if (!fetched) {
        onFallback?.(name, `Langfuse has no version labelled ${label}`);
      } else {
        return {
          name,
          text: fillPlaceholders(fetched.text, name, variables),
          version: fetched.version,
        };
      }
    } catch (error) {
      onFallback?.(name, messageOf(error));
    }
  }
  return { name, text: loadPrompt(name, variables), version: undefined };
}

/** Where each prompt came from, for the trace metadata and the CLI's startup line. */
export function promptVersions(prompts: Prompts): Record<string, string> {
  return Object.fromEntries(
    prompts.resolved.map((prompt) => [
      prompt.name,
      prompt.version === undefined ? "file" : `langfuse v${prompt.version}`,
    ]),
  );
}
