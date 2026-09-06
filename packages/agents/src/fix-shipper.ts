import type { LanguageModelLike } from "@langchain/core/language_models/base";
import type { StructuredTool } from "@langchain/core/tools";
import type { SubAgent } from "deepagents";
import { toolStrategy } from "langchain";
import { createGitDiffNamesTool } from "./code-tools";
import { createGithubGuard, fixShipperGithubToolNames, type GithubRepo } from "./github";
import type { Prompts } from "./prompts";
import { fixShipperSchema } from "./schemas";
import { FIX_SHIPPER, selectTools } from "./subagents";
import { createToolErrorGuard } from "./tool-errors";
import type { Workspace } from "./workspace";
import { workspaceReadable } from "./workspace-mount";

/**
 * The Fix Shipper: the subagent that carries Code RCA's patch out of the Workspace and onto
 * GitHub. It lists what changed, reads those files, and pushes them to this Ticket's branch
 * through the GitHub MCP server (PLAN.md section 4).
 *
 * Nothing here is a git command. There is no remote in the Workspace clone that could be
 * pushed to, no credential on this machine, and no shell to use one with: the only route to
 * GitHub is the MCP server's token, and the only repository and branch it can be aimed at are
 * fixed by the guard below rather than chosen by the model.
 *
 * Opening the pull request is not the Fix Shipper's. That is the Resolver's `create_pull_request`,
 * and it is behind the approval gate (ADR-0003): a branch nobody merges is not a write anyone
 * needs to hold, and a pull request against ShopLite's default branch is.
 */

export type FixShipperOptions = {
  model: LanguageModelLike;
  prompts: Prompts;
  /** This Ticket's clone, which Code RCA has already patched by the time this subagent runs. */
  workspace: Workspace;
  /** Every tool the MCP client loaded; the GitHub ones are picked out by name. */
  tools: StructuredTool[];
  /** The repository the push is aimed at, read from the configured ShopLite clone url. */
  repo: GithubRepo;
  /** The branch the Ticket's branch is cut from: ShopLite's default branch, from config. */
  base: string;
  /** The branch to push to, derived from the Ticket id by whoever built the run. */
  branch: string;
};

export function createFixShipperSubagent({
  model,
  prompts,
  workspace,
  tools,
  repo,
  base,
  branch,
}: FixShipperOptions): SubAgent {
  return {
    name: FIX_SHIPPER,
    description:
      "Puts Code RCA's patch on GitHub. It lists the files changed in the Workspace, reads them, " +
      "and pushes them to a branch named from this Ticket, then reports the branch and the pull " +
      "request title and body to open from it. Delegate to it once Code RCA reports the tests are " +
      "green, with its root cause, the failing test it wrote, and what the patch changes. It does " +
      "not open the pull request: that is your own gated call.",
    systemPrompt: prompts.text("fix-shipper"),
    model,
    tools: [createGitDiffNamesTool(workspace), ...selectTools(tools, fixShipperGithubToolNames)],
    // Read-only on the Workspace: what reaches the branch is what Code RCA left there.
    permissions: workspaceReadable,
    // The error guard is outermost so a refusal from GitHub comes back as something to read.
    // The target guard is innermost, so the call that leaves is aimed at this repository and
    // this branch whatever the model wrote in its arguments.
    middleware: [createToolErrorGuard(), createGithubGuard({ ...repo, branch, base })],
    responseFormat: toolStrategy(fixShipperSchema),
  };
}
