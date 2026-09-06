import { LangfuseClient } from "@langfuse/client";
import type { PromptFetcher, PromptName } from "./prompts";

/**
 * Langfuse prompt management. `pnpm prompts:sync` pushes the repository's markdown here under
 * a label, and the agents fetch by name and label at startup. The keys are secrets and come
 * from the environment; without them there is no client and every prompt comes from its file.
 */
export type LangfuseCredentials = {
  publicKey?: string | undefined;
  secretKey?: string | undefined;
  baseUrl?: string | undefined;
};

/**
 * How long a prompt fetch may take before a run gives up and reads the file instead. Short on
 * purpose: a slow or hanging Langfuse must not hold up a Ticket, and the fallback is a local
 * read. One retry covers a dropped connection without doubling the wait again.
 */
const fetchTimeoutMs = 5_000;
const maxRetries = 1;

/** The client for prompt management, or undefined when the Langfuse keys are not set. */
export function createPromptClient({
  publicKey,
  secretKey,
  baseUrl,
}: LangfuseCredentials): LangfuseClient | undefined {
  if (!publicKey || !secretKey) return undefined;
  return new LangfuseClient({ publicKey, secretKey, baseUrl });
}

/** A 404 from Langfuse: the prompt exists nowhere, or has no version under that label. */
export function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    (error as { statusCode?: unknown }).statusCode === 404
  );
}

/**
 * Reads a prompt by name and label for a run, under the startup deadline. A label with no
 * version is not an error: it means this prompt has never been synced, and the caller falls
 * back to the repository file. Anything else — a bad key, an unreachable host, the deadline —
 * is thrown so the reason reaches the run's log.
 */
export function langfusePromptFetcher(client: LangfuseClient): PromptFetcher {
  return (name, label) => readPrompt(client, name, label, { fetchTimeoutMs, maxRetries });
}

/** What a sync did to one prompt: pushed a new version, or left the label where it was. */
export type SyncResult = { name: PromptName; action: "push" | "unchanged"; version: number };

/**
 * Pushes one prompt's markdown as a new version under the label, unless the labelled version
 * already says exactly that. The comparison reads past the SDK's cache, so a sync run twice in
 * quick succession sees the version it just pushed rather than the one remembered from before.
 */
export async function syncPrompt(
  client: LangfuseClient,
  name: PromptName,
  text: string,
  label: string,
): Promise<SyncResult> {
  const labelled = await readPrompt(client, name, label, { cacheTtlSeconds: 0 });
  if (labelled?.text === text) {
    return { name, action: "unchanged", version: labelled.version };
  }
  const created = await client.prompt.create({ name, prompt: text, labels: [label], type: "text" });
  return { name, action: "push", version: created.version };
}

type ReadOptions = { fetchTimeoutMs?: number; maxRetries?: number; cacheTtlSeconds?: number };

async function readPrompt(
  client: LangfuseClient,
  name: PromptName,
  label: string,
  options: ReadOptions,
): Promise<{ text: string; version: number } | undefined> {
  try {
    const prompt = await client.prompt.get(name, { label, type: "text", ...options });
    return { text: prompt.prompt, version: prompt.version };
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}
