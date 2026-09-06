import { messageOf } from "@incident-resolver/shared";
import type { LanguageModelLike } from "@langchain/core/language_models/base";
import {
  CompositeBackend,
  FilesystemBackend,
  type FilesystemPermission,
  StateBackend,
  type SubAgent,
} from "deepagents";
import { createMiddleware, ToolMessage, toolStrategy } from "langchain";
import { createCodeTools } from "./code-tools";
import type { Prompts } from "./prompts";
import { codeRcaSchema } from "./schemas";
import { CODE_RCA } from "./subagents";
import { createToolErrorGuard } from "./tool-errors";
import type { Workspace } from "./workspace";

/**
 * Code RCA: the subagent that reads ShopLite's source, reproduces the bug with a failing test,
 * patches it, and runs the suite green — in a Workspace it cannot get out of, with no shell.
 *
 * Two things confine it, and both are configuration rather than prompt. The Workspace is
 * mounted at one route on the agent's filesystem, backed by a `FilesystemBackend` in virtual
 * mode, so a path that climbs out of the clone is rejected before it reaches the disk. And the
 * route is denied to the Resolver and every other subagent and allowed only here, so the one
 * agent that can touch ShopLite's code is the one whose job it is (ADR-0002).
 */

/** Where the Workspace is mounted in the agent's view of the filesystem. */
export const WORKSPACE_ROUTE = "/workspace";

/**
 * The same mount as CompositeBackend wants it registered. The trailing slash is load-bearing:
 * the composite strips the route by length and prefixes a slash back, so a route without one
 * hands the Workspace's backend a doubled `//path` that no file matches.
 */
const WORKSPACE_MOUNT = `${WORKSPACE_ROUTE}/`;

const workspacePaths = [WORKSPACE_ROUTE, `${WORKSPACE_ROUTE}/**`];

/**
 * The agent's filesystem: the Workspace at its route, everything else in graph state as before.
 *
 * Routing rather than rooting the whole agent at the clone is what keeps the agent's own
 * scratch files — the large tool results the filesystem middleware evicts — out of ShopLite's
 * working tree, where `git_diff_names` would report them as part of the patch.
 *
 * Note the composite supports no `execute`, so the filesystem middleware drops its shell tool:
 * there is no command in this agent that this repository did not write.
 */
export function workspaceBackend(workspace: Workspace): CompositeBackend {
  return new CompositeBackend(new StateBackend(), {
    [WORKSPACE_MOUNT]: new FilesystemBackend({ rootDir: workspace.dir, virtualMode: true }),
  });
}

/** Who may read and write the Workspace. `mode` is the whole difference between the two rules. */
function workspaceRule(mode: "allow" | "deny"): FilesystemPermission[] {
  return [{ operations: ["read", "write"], paths: workspacePaths, mode }];
}

/** The Resolver's rule and every subagent's that does not override it: the Workspace is closed. */
export const workspaceClosed = workspaceRule("deny");

/**
 * Clones ShopLite before Code RCA is handed the delegation, and never before that.
 *
 * The clone has to happen here rather than inside the two commands, because the first thing
 * Code RCA is told to do is read: its file tools go straight at `workspace.dir`, and a
 * directory that is not there yet reads as a Workspace with no ShopLite in it. Waiting until
 * the delegation is also what keeps the cost off every other Ticket — a Question answered from
 * a Help article never reaches this middleware, so it never pays for a clone and an install.
 *
 * A clone that fails comes back as a tool error rather than ending the run, the way a refused
 * delegation does: the Resolver reads it and escalates with what the Evidence already showed.
 */
export function createWorkspaceProvisioner(workspace: Workspace) {
  return createMiddleware({
    name: "workspace-provisioner",
    wrapToolCall: async (request, handler) => {
      if (request.toolCall.name !== "task" || request.toolCall.args.subagent_type !== CODE_RCA) {
        return handler(request);
      }
      try {
        await workspace.ready();
      } catch (error) {
        return new ToolMessage({
          tool_call_id: request.toolCall.id ?? "",
          name: request.toolCall.name,
          content:
            `Code RCA could not start: ${messageOf(error)}. There is no Workspace to read ` +
            "ShopLite's code in, so describe the defect from the Evidence in rootCause and escalate.",
          status: "error",
        });
      }
      return handler(request);
    },
  });
}

/** Shaped like the other subagent factories' options, with the Workspace where their tools go. */
export type CodeRcaOptions = {
  model: LanguageModelLike;
  prompts: Prompts;
  workspace: Workspace;
};

export function createCodeRcaSubagent({ model, prompts, workspace }: CodeRcaOptions): SubAgent {
  return {
    name: CODE_RCA,
    description:
      "Finds the cause of a code bug in ShopLite's source and fixes it. It works in this " +
      "Ticket's own clone of the repository: it reads the code, writes a test that fails the " +
      "way the Reporter described, patches the defect, and runs the suite until it is green. " +
      "Returns the root cause with the file and the line, the test it wrote, the files it " +
      "changed, and whether the tests pass. Give it the Ticket and the Evidence that points at " +
      "the code. It has no shell and cannot leave the Workspace, so nothing it does reaches " +
      "ShopLite's running data or this machine.",
    systemPrompt: prompts.text("code-rca"),
    model,
    tools: createCodeTools(workspace),
    permissions: workspaceRule("allow"),
    middleware: [createToolErrorGuard()],
    responseFormat: toolStrategy(codeRcaSchema),
  };
}
