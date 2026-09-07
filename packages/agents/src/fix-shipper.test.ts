import type { LanguageModelLike } from "@langchain/core/language_models/base";
import { ToolMessage, tool } from "langchain";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { GIT_DIFF_NAMES, RUN_TESTS } from "./code-tools";
import { createFixShipperSubagent } from "./fix-shipper";
import { CREATE_BRANCH, fixShipperGithubToolNames, PUSH_FILES } from "./github";
import { loadPrompt, type Prompts } from "./prompts";
import { FIX_SHIPPER } from "./subagents";
import type { Workspace } from "./workspace";
import { WORKSPACE_ROUTE } from "./workspace-mount";

const model = {} as LanguageModelLike;

const prompts: Prompts = { label: "test", resolved: [], text: (name) => loadPrompt(name) };

const workspace: Workspace = {
  ticketId: "3f7c1b52-8f0f-4a9f-9b1a-2c9d5e6f7a80",
  dir: "/tmp/workspace",
  async ready() {},
  async run() {
    return { exitCode: 0, stdout: "", stderr: "" };
  },
};

const repo = { owner: "nirajk77777", repo: "shoplite" };
const branch = `fix/ticket-${workspace.ticketId}`;

/** Stand-ins for the GitHub MCP tools, which are loaded by name like every other MCP tool. */
const githubTools = [...fixShipperGithubToolNames].map((name) =>
  tool(async () => "not called", { name, description: name, schema: z.object({}).loose() }),
);

const subagent = () =>
  createFixShipperSubagent({
    model,
    prompts,
    workspace,
    tools: githubTools,
    repo,
    base: "main",
    branch,
  });

describe("the Fix Shipper subagent", () => {
  it("lists what changed and pushes it, and can do nothing else", () => {
    expect(subagent().name).toBe(FIX_SHIPPER);
    expect(subagent().tools?.map((one) => one.name)).toEqual([
      GIT_DIFF_NAMES,
      CREATE_BRANCH,
      PUSH_FILES,
    ]);
  });

  it("does not get run_tests: the suite was Code RCA's to run, in the Workspace", () => {
    expect(subagent().tools?.map((one) => one.name)).not.toContain(RUN_TESTS);
  });

  it("reads the Workspace and cannot write to it", () => {
    expect(subagent().permissions).toEqual([
      { operations: ["read"], paths: [WORKSPACE_ROUTE, `${WORKSPACE_ROUTE}/**`], mode: "allow" },
      { operations: ["write"], paths: [WORKSPACE_ROUTE, `${WORKSPACE_ROUTE}/**`], mode: "deny" },
    ]);
  });

  it("fails loudly when the GitHub MCP server did not load its tools", () => {
    expect(() =>
      createFixShipperSubagent({
        model,
        prompts,
        workspace,
        tools: [],
        repo,
        base: "main",
        branch,
      }),
    ).toThrow(/create_branch/);
  });

  it("aims every push at this Ticket's branch of the configured repository", async () => {
    const guard = subagent().middleware?.at(-1);
    let seen: Record<string, unknown> | undefined;

    await guard?.wrapToolCall?.(
      {
        toolCall: {
          id: "c1",
          name: PUSH_FILES,
          args: { owner: "someone", repo: "else", branch: "main", message: "fix" },
        },
        tool: undefined,
        state: { messages: [] },
      } as never,
      ((request: { toolCall: { args: Record<string, unknown> } }) => {
        seen = request.toolCall.args;
        return new ToolMessage({ tool_call_id: "c1", name: PUSH_FILES, content: "ok" });
      }) as never,
    );

    expect(seen).toEqual({
      owner: "nirajk77777",
      repo: "shoplite",
      branch,
      message: "fix",
    });
  });
});

describe("the Fix Shipper prompt", () => {
  it("names the route the Workspace is mounted at and the tools it is given", () => {
    const prompt = loadPrompt("fix-shipper");

    expect(prompt).toContain(WORKSPACE_ROUTE);
    expect(prompt).toContain(GIT_DIFF_NAMES);
    expect(prompt).toContain(CREATE_BRANCH);
    expect(prompt).toContain(PUSH_FILES);
  });

  it("says the pull request is not its to open", () => {
    expect(loadPrompt("fix-shipper")).toMatch(/do not open the pull request/i);
  });
});
