import { messageOf } from "@incident-resolver/shared";
import { getConfig } from "@incident-resolver/shared/config";
import { createPromptClient, syncPrompt } from "../src/langfuse-prompts";
import { promptNames, readPromptFile } from "../src/prompts";

/**
 * Pushes every prompt in `packages/agents/prompts/` to Langfuse prompt management under
 * `LANGFUSE_PROMPT_LABEL`, so a trace says which version of which prompt produced it. The
 * markdown is pushed with its `{{placeholders}}` intact: the agent fills them from config at
 * startup, the same way it fills the local file. A prompt whose text already matches the
 * labelled version keeps its version number rather than gaining an identical one.
 *
 * Needs LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY. Nothing else depends on this having run:
 * a prompt Langfuse does not have is read from its file.
 */
const log = (line: string) => console.error(line);

async function main(): Promise<void> {
  const config = getConfig();
  const client = createPromptClient({
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: process.env.LANGFUSE_SECRET_KEY,
    baseUrl: config.infra.langfuseBaseUrl,
  });
  if (!client) {
    throw new Error(
      "LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are not set; there is nowhere to sync prompts to",
    );
  }

  const label = config.infra.langfusePromptLabel;
  log(`Syncing ${promptNames.length} prompts to ${config.infra.langfuseBaseUrl} as ${label}`);

  // In order and one at a time: the output reads as a list, and a failure names the prompt it stopped at.
  for (const name of promptNames) {
    const result = await syncPrompt(client, name, readPromptFile(name), label);
    log(
      result.action === "push"
        ? `  ${name}: pushed as v${result.version}`
        : `  ${name}: unchanged, still v${result.version}`,
    );
  }
}

try {
  await main();
} catch (error) {
  log(`prompts:sync failed: ${messageOf(error)}`);
  process.exit(1);
}
