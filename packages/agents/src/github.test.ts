import type { ToolCall } from "@langchain/core/messages/tool";
import { describe, expect, it } from "vitest";
import {
  branchNameFor,
  createPullRequestOpener,
  githubConnection,
  openedPullRequestOf,
  PUSH_FILES,
  parseRepo,
  withFixedTarget,
} from "./github";

const target = { owner: "nirajk77777", repo: "shoplite", branch: "fix/ticket-1", base: "main" };
const repo = { owner: "nirajk77777", repo: "shoplite" };

describe("parseRepo", () => {
  it("reads the owner and the repository out of an https clone url", () => {
    expect(parseRepo("https://github.com/nirajk77777/shoplite.git")).toEqual({
      owner: "nirajk77777",
      repo: "shoplite",
    });
  });

  it("reads them out of an https url without the .git suffix, or with a trailing slash", () => {
    expect(parseRepo("https://github.com/acme/shop")).toEqual({ owner: "acme", repo: "shop" });
    expect(parseRepo("https://github.com/acme/shop/")).toEqual({ owner: "acme", repo: "shop" });
  });

  it("reads them out of an ssh remote", () => {
    expect(parseRepo("git@github.com:acme/shop.git")).toEqual({ owner: "acme", repo: "shop" });
  });

  it("refuses a url that does not name one GitHub repository", () => {
    expect(() => parseRepo("https://gitlab.com/acme/shop.git")).toThrow(/GitHub/);
    expect(() => parseRepo("https://github.com/acme")).toThrow(/owner/);
  });
});

describe("branchNameFor", () => {
  it("names the branch from the Ticket id, so the branch says which Ticket it belongs to", () => {
    expect(branchNameFor("3f7c1b52-8f0f-4a9f-9b1a-2c9d5e6f7a80")).toBe(
      "fix/ticket-3f7c1b52-8f0f-4a9f-9b1a-2c9d5e6f7a80",
    );
  });

  it("refuses a Ticket id that is not a name a git ref can carry", () => {
    expect(() => branchNameFor("../../main")).toThrow(/Ticket id/);
    expect(() => branchNameFor("")).toThrow(/Ticket id/);
  });
});

describe("githubConnection", () => {
  it("connects over HTTP with the token and the toolsets the server may expose", () => {
    const connection = githubConnection({
      url: "https://api.githubcopilot.com/mcp/",
      token: "ghp_secret",
      toolsets: "repos,pull_requests",
    });

    expect(connection.transport).toBe("http");
    expect(connection.url).toBe("https://api.githubcopilot.com/mcp/");
    expect(connection.headers).toMatchObject({
      Authorization: "Bearer ghp_secret",
      "X-MCP-Toolsets": "repos,pull_requests",
    });
  });
});

describe("withFixedTarget", () => {
  const call = (name: string, args: Record<string, unknown>): ToolCall => ({
    name,
    args,
    id: "call-1",
    type: "tool_call",
  });

  it("pushes to this Ticket's branch of ShopLite whatever the model asked for", () => {
    const fixed = withFixedTarget(
      call(PUSH_FILES, {
        owner: "someone-else",
        repo: "their-repo",
        branch: "main",
        message: "fix",
        files: [{ path: "a.ts", content: "x" }],
      }),
      target,
    );

    expect(fixed.args).toEqual({
      owner: "nirajk77777",
      repo: "shoplite",
      branch: "fix/ticket-1",
      message: "fix",
      files: [{ path: "a.ts", content: "x" }],
    });
  });

  it("leaves the Workspace tools alone: only GitHub has an owner and a repo", () => {
    const untouched = call("git_diff_names", {});
    expect(withFixedTarget(untouched, target)).toBe(untouched);
  });
});

describe("openedPullRequestOf", () => {
  const url = "https://github.com/nirajk77777/shoplite/pull/7";

  it("reads the pull request out of what the GitHub MCP server returned", () => {
    const result = JSON.stringify({ number: 7, html_url: url });
    expect(openedPullRequestOf(result, repo)).toEqual({ url, number: 7 });
  });

  it("finds the url in prose when the server wrapped it in a sentence", () => {
    const result = `Created pull request ${url} on branch fix/ticket-1.`;
    expect(openedPullRequestOf(result, repo)).toEqual({ url, number: 7 });
  });

  it("reports nothing when there is no pull request in the answer", () => {
    expect(openedPullRequestOf("Not Found", repo)).toBeUndefined();
    expect(openedPullRequestOf(undefined, repo)).toBeUndefined();
  });

  it("does not read a url from another repository as a pull request opened here", () => {
    // GitHub quotes things back in its error bodies, and a link to somewhere else is not a
    // pull request this run opened.
    const elsewhere = "422: see https://github.com/someone/else/pull/3 for the duplicate";
    expect(openedPullRequestOf(elsewhere, repo)).toBeUndefined();
  });
});

describe("createPullRequestOpener", () => {
  const request = {
    title: "Fix the double discount",
    body: "## Root cause\nIt is applied twice.",
    files: ["src/discount.ts"],
  };

  function opener(invoke: (args: Record<string, unknown>) => Promise<unknown>) {
    return createPullRequestOpener({
      tool: { invoke } as never,
      repo,
      base: "main",
      branch: "fix/ticket-1",
    });
  }

  it("opens the pull request from the Ticket's branch onto the default branch", async () => {
    const seen: Record<string, unknown>[] = [];
    const open = opener(async (args) => {
      seen.push(args);
      return JSON.stringify({
        number: 3,
        html_url: "https://github.com/nirajk77777/shoplite/pull/3",
      });
    });

    const opened = await open(request);

    expect(seen).toEqual([
      {
        owner: "nirajk77777",
        repo: "shoplite",
        head: "fix/ticket-1",
        base: "main",
        title: request.title,
        body: request.body,
      },
    ]);
    expect(opened).toEqual({
      ok: true,
      url: "https://github.com/nirajk77777/shoplite/pull/3",
      number: 3,
    });
  });

  it("reports a refusal from GitHub as a reason rather than throwing at the Resolver", async () => {
    const open = opener(async () => {
      throw new Error("422 Validation Failed: no commits between main and fix/ticket-1");
    });

    await expect(open(request)).resolves.toEqual({
      ok: false,
      reason: expect.stringContaining("422"),
    });
  });

  it("reports an answer with no pull request in it rather than claiming one was opened", async () => {
    const open = opener(async () => "the branch does not exist");

    await expect(open(request)).resolves.toMatchObject({ ok: false });
  });
});
