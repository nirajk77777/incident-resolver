import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelLike } from "@langchain/core/language_models/base";
import { isSandboxBackend } from "deepagents";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCodeRcaSubagent,
  createWorkspaceProvisioner,
  WORKSPACE_ROUTE,
  workspaceBackend,
} from "./code-rca";
import { GIT_DIFF_NAMES, RUN_TESTS } from "./code-tools";
import { loadPrompt, type Prompts } from "./prompts";
import { CODE_RCA } from "./subagents";
import type { Workspace } from "./workspace";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A Workspace that is already a real directory holding one ShopLite file. */
async function clonedWorkspace(): Promise<Workspace> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "workspace-")));
  dirs.push(dir);
  await mkdir(join(dir, "apps/api/src/domain"), { recursive: true });
  await writeFile(
    join(dir, "apps/api/src/domain/order.ts"),
    "export function finalizeOrder() {}\n",
  );
  return {
    ticketId: "ticket-1",
    dir,
    ready: async () => {},
    run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  };
}

// The subagent only reads its own prompt; the rest of a resolved Prompts is not its business.
const prompts = { text: () => "You are Code RCA." } as unknown as Prompts;
const model = "gpt-5.4" as unknown as LanguageModelLike;

describe("workspaceBackend", () => {
  it("reads a file inside the Workspace", async () => {
    const backend = workspaceBackend(await clonedWorkspace());

    const result = await backend.read(`${WORKSPACE_ROUTE}/apps/api/src/domain/order.ts`);

    expect(result.error).toBeUndefined();
    expect(String(result.content)).toContain("finalizeOrder");
  });

  it("rejects a path that climbs out of the Workspace", async () => {
    const backend = workspaceBackend(await clonedWorkspace());

    const escaped = await backend
      .read(`${WORKSPACE_ROUTE}/../../../../etc/passwd`)
      .catch((error: unknown) => ({ error: String(error), content: undefined }));

    expect(escaped.error).toBeDefined();
    expect(escaped.content).toBeUndefined();
  });

  it("rejects a write that climbs out of the Workspace", async () => {
    const backend = workspaceBackend(await clonedWorkspace());

    const escaped = await backend
      .write(`${WORKSPACE_ROUTE}/../escaped.txt`, "no")
      .catch((error: unknown) => ({ error: String(error) }));

    expect(escaped.error).toBeDefined();
  });

  it("supports no command execution, so there is no shell to reach (ADR-0002)", async () => {
    expect(isSandboxBackend(workspaceBackend(await clonedWorkspace()))).toBe(false);
  });
});

describe("createCodeRcaSubagent", () => {
  it("gets the two named tools and nothing else", async () => {
    const subagent = createCodeRcaSubagent({ model, prompts, workspace: await clonedWorkspace() });

    expect(subagent.name).toBe(CODE_RCA);
    expect(subagent.tools?.map((tool) => tool.name)).toEqual([RUN_TESTS, GIT_DIFF_NAMES]);
  });

  it("is the only subagent allowed into the Workspace", async () => {
    const subagent = createCodeRcaSubagent({ model, prompts, workspace: await clonedWorkspace() });

    expect(subagent.permissions).toEqual([
      {
        operations: ["read", "write"],
        paths: [WORKSPACE_ROUTE, `${WORKSPACE_ROUTE}/**`],
        mode: "allow",
      },
    ]);
  });
});

describe("the Code RCA prompt", () => {
  it("names the route the Workspace is actually mounted at", () => {
    // The prompt tells the agent where its Workspace is in plain text, so the two have to
    // agree: a prompt naming a route the backend does not serve sends it to an empty directory.
    expect(loadPrompt("code-rca")).toContain(WORKSPACE_ROUTE);
  });

  it("names the two tools the subagent is actually given", () => {
    const prompt = loadPrompt("code-rca");

    expect(prompt).toContain(RUN_TESTS);
    expect(prompt).toContain(GIT_DIFF_NAMES);
  });
});

describe("createWorkspaceProvisioner", () => {
  const task = (subagent: string) => ({
    id: "call-1",
    name: "task",
    args: { description: "find it", subagent_type: subagent },
  });

  /** A Workspace that counts how often it was made ready, and never clones anything. */
  function countingWorkspace() {
    let readied = 0;
    const workspace: Workspace = {
      ticketId: "ticket-1",
      dir: "/workspaces/ticket-1",
      ready: async () => {
        readied += 1;
      },
      run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    };
    return { workspace, readied: () => readied };
  }

  const wrap = (
    workspace: Workspace,
    toolCall: ReturnType<typeof task>,
    handler: () => unknown = () => "handled",
  ) =>
    createWorkspaceProvisioner(workspace).wrapToolCall?.(
      { toolCall, tool: undefined, state: { messages: [] } } as never,
      handler as never,
    );

  it("clones the Workspace before Code RCA is handed the delegation", async () => {
    const { workspace, readied } = countingWorkspace();
    const order: string[] = [];

    await wrap(workspace, task(CODE_RCA), () => {
      order.push(`handled after ${readied()} clone(s)`);
      return "handled";
    });

    expect(order).toEqual(["handled after 1 clone(s)"]);
  });

  it("clones nothing for any other delegation", async () => {
    const { workspace, readied } = countingWorkspace();

    await wrap(workspace, task("log-investigator"));

    expect(readied()).toBe(0);
  });

  it("tells the Resolver what went wrong rather than ending the run", async () => {
    const workspace: Workspace = {
      ticketId: "ticket-1",
      dir: "/workspaces/ticket-1",
      ready: async () => {
        throw new Error("Could not clone the Workspace for Ticket ticket-1: host unreachable");
      },
      run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    };

    const reply = (await wrap(workspace, task(CODE_RCA), () => {
      throw new Error("must not run");
    })) as { status: string; content: string };

    expect(reply.status).toBe("error");
    expect(reply.content).toContain("host unreachable");
  });
});
