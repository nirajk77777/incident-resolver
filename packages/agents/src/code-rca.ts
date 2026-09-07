import { messageOf } from "@incident-resolver/shared";
import type { LanguageModelLike } from "@langchain/core/language_models/base";
import type { SubAgent } from "deepagents";
import { createMiddleware, ToolMessage, toolStrategy } from "langchain";
import { createCodeTools } from "./code-tools";
import type { Prompts } from "./prompts";
import { codeRcaSchema } from "./schemas";
import { CODE_RCA } from "./subagents";
import { createToolErrorGuard } from "./tool-errors";
import type { Workspace } from "./workspace";
import { workspaceWritable } from "./workspace-mount";

/**
 * Code RCA: the subagent that reads ShopLite's source, reproduces the bug with a failing test,
 * patches it, and runs the suite green — in a Workspace it cannot get out of, with no shell.
 *
 * What confines it is the mount in `workspace-mount.ts`: the clone sits at one route on the
 * agent's filesystem, closed to the Resolver and to every other subagent, and this is the one
 * agent the route is opened to for writing (ADR-0002).
 */

/**
 * Clones ShopLite before Code RCA is handed the delegation, and never before that.
 *
 * The clone has to happen here rather than inside the two commands, because the first thing
 * Code RCA is told to do is read: its file tools go straight at `workspace.dir`, and a
 * directory that is not there yet reads as a Workspace with no ShopLite in it. Waiting until
 * the delegation is also what keeps the cost off every other Ticket — a Question answered from
 * a Help article never reaches this middleware, so it never pays for a clone and an install.
 *
 * The Fix Shipper needs no clone of its own: it only runs once Code RCA has reported, so by
 * then this has already made one.
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
    permissions: workspaceWritable,
    middleware: [createToolErrorGuard()],
    responseFormat: toolStrategy(codeRcaSchema),
  };
}
