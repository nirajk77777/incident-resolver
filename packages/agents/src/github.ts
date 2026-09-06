import { messageOf } from "@incident-resolver/shared";
import type { ToolCall } from "@langchain/core/messages/tool";
import type { StructuredTool } from "@langchain/core/tools";
import type { StreamableHTTPConnection } from "@langchain/mcp-adapters";
import { createMiddleware } from "langchain";
import type { OpenPullRequest, PullRequestOpened, PullRequestRequest } from "./write-tools";

/**
 * GitHub, as the one MCP server this repository buys rather than builds (PLAN.md section 3).
 * It is the official remote server, reached over HTTP with a personal access token, and it is
 * the only way anything here reaches GitHub: there is no git remote configured in a Workspace
 * and no credential on this machine that a push could use.
 *
 * Two things bound what the token can do. The toolsets header is what the server will expose
 * at all, and it is narrowed to the two the Fix Shipper needs. And every call the Fix Shipper
 * makes has its owner, repository, and branch overwritten here — the guard below — so the
 * repository it pushes to is the one the portal is configured for rather than one the model
 * named. The pull request itself is not the Fix Shipper's to open: it is the Resolver's gated
 * write, and `createPullRequestOpener` is the single call behind the approval (ADR-0003).
 */

/** The MCP server's name, as the client's map of servers keys it. */
export const GITHUB = "github";

export const CREATE_BRANCH = "create_branch";
export const PUSH_FILES = "push_files";
/**
 * The remote server's own tool, which only `createPullRequestOpener` below ever calls. It is
 * named the same as the Resolver's gated write tool by coincidence rather than by connection:
 * that name comes from `approvalActions`, and the two are never in the same agent's tool list.
 */
export const GITHUB_PULL_REQUEST_TOOL = "create_pull_request";

/** What the Fix Shipper gets: a branch to put the patch on, and the push that puts it there. */
export const fixShipperGithubToolNames = [CREATE_BRANCH, PUSH_FILES] as const;

/** Every GitHub tool a run needs before it can ship a fix at all. */
export const githubToolNames = [...fixShipperGithubToolNames, GITHUB_PULL_REQUEST_TOOL] as const;

/** One GitHub repository. */
export type GithubRepo = { owner: string; repo: string };

/** Where the Fix Shipper is allowed to push: one repository, one branch, cut from one base. */
export type PushTarget = GithubRepo & {
  branch: string;
  /** The branch the new one is cut from, and the one the pull request is opened against. */
  base: string;
};

const HTTPS_REMOTE = /^https:\/\/github\.com\/(?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?\/?$/;
const SSH_REMOTE = /^git@github\.com:(?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?$/;

/**
 * The repository a clone url names. Read from `SHOPLITE_REPO_URL` rather than configured
 * twice, so the repository Code RCA works in a clone of and the one the pull request is
 * opened against cannot drift apart.
 */
export function parseRepo(repoUrl: string): GithubRepo {
  const matched = HTTPS_REMOTE.exec(repoUrl.trim()) ?? SSH_REMOTE.exec(repoUrl.trim());
  const groups = matched?.groups;
  if (!groups) {
    throw new Error(
      `${repoUrl} does not name a GitHub repository as owner and name, so no pull request can be opened against it`,
    );
  }
  return { owner: groups.owner as string, repo: groups.repo as string };
}

/** A Ticket id as a branch name: anything else would name a branch belonging to no Ticket. */
const REF_SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The branch one Ticket's patch is pushed to. Derived rather than asked of the model, so the
 * branch on GitHub says which Ticket it came from and a re-run of the same Ticket updates its
 * own branch instead of opening a second one beside it.
 */
export function branchNameFor(ticketId: string): string {
  if (!REF_SAFE.test(ticketId)) {
    throw new Error(`Ticket id ${ticketId} does not name a branch`);
  }
  return `fix/ticket-${ticketId}`;
}

export type GithubConnectionOptions = {
  /** The remote server's endpoint, from config. */
  url: string;
  /** The personal access token. A secret, so it comes from the environment. */
  token: string;
  /** The toolsets the server may expose to this run, comma-separated. */
  toolsets: string;
};

/** The GitHub MCP server as the client connects to it: HTTP, with the token on every request. */
export function githubConnection({
  url,
  token,
  toolsets,
}: GithubConnectionOptions): StreamableHTTPConnection {
  return {
    transport: "http",
    url,
    headers: {
      Authorization: `Bearer ${token}`,
      // The official server reads this and exposes only these toolsets, so a tool outside
      // them is not something the Fix Shipper was told not to call: it is not there to call.
      "X-MCP-Toolsets": toolsets,
    },
  };
}

/**
 * One GitHub call, aimed at this Ticket's branch of ShopLite. Every part of where the call
 * goes is the portal's to decide, so all of it is overwritten rather than validated: a model
 * that names another repository pushes to this one, and the prompt is left to say what the
 * call is for rather than to be the thing that keeps it in bounds. `create_branch` has its
 * base fixed too, or the branch could be cut from anywhere in the repository and the pull
 * request would carry whatever else was on it.
 */
export function withFixedTarget(toolCall: ToolCall, target: PushTarget): ToolCall {
  const { owner, repo, branch, base } = target;
  if (toolCall.name === CREATE_BRANCH) {
    return { ...toolCall, args: { ...toolCall.args, owner, repo, branch, from_branch: base } };
  }
  if (toolCall.name === PUSH_FILES) {
    return { ...toolCall, args: { ...toolCall.args, owner, repo, branch } };
  }
  return toolCall;
}

/** The guard as middleware: every GitHub call the Fix Shipper makes goes through it. */
export function createGithubGuard(target: PushTarget) {
  return createMiddleware({
    name: "github-target-guard",
    wrapToolCall: (request, handler) =>
      handler({ ...request, toolCall: withFixedTarget(request.toolCall, target) }),
  });
}

/** A pull request that exists on GitHub, as the answer to `create_pull_request` reported it. */
export type OpenedPullRequest = { url: string; number: number };

/** Anything that could be read as a url, quoted or not, is bounded here rather than in the regex. */
const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The pull request in a tool result, or nothing when there is none. The remote server answers
 * with the GitHub API's own JSON, but a failure answers with prose, and the difference between
 * the two is the whole question of whether a pull request was opened — so this looks for the
 * one thing only a real pull request has, its url, rather than trusting the shape.
 *
 * The url has to be on the repository this run is configured for. GitHub's own error bodies
 * quote things back, and a url from anywhere else in an error is not a pull request that was
 * opened here. Note what this does not rescue: a re-run whose branch already has a pull
 * request gets a 422 with no url in it, so it reads as not opened and the Ticket escalates
 * with GitHub's own message saying the pull request already exists.
 */
export function openedPullRequestOf(
  result: unknown,
  repo: GithubRepo,
): OpenedPullRequest | undefined {
  const text = textOf(result);
  if (text === undefined) return undefined;
  const pattern = new RegExp(
    `https://github\\.com/${escaped(repo.owner)}/${escaped(repo.repo)}/pull/(\\d+)`,
  );
  const matched = pattern.exec(text);
  if (!matched) return undefined;
  return { url: matched[0], number: Number(matched[1]) };
}

/** A tool result as text, whatever content blocks it arrived in. */
function textOf(result: unknown): string | undefined {
  if (result === undefined || result === null) return undefined;
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result);
  } catch {
    return undefined;
  }
}

export type PullRequestOpenerOptions = {
  /** The GitHub MCP server's `create_pull_request`, loaded with the rest of the run's tools. */
  tool: StructuredTool;
  repo: GithubRepo;
  /** The branch the pull request is opened against: ShopLite's default branch, from config. */
  base: string;
  /** The branch the patch is on, derived from the Ticket id — never a string from the model. */
  branch: string;
};

/**
 * The one call that opens a pull request, and the only thing behind the approval gate's
 * `create_pull_request`. It is a plain function rather than a tool the agent holds, because
 * by the time it runs the decision has already been made by a person: the Resolver asked, the
 * graph stopped, and a Reviewer approved. A refusal from GitHub comes back as a reason the
 * Resolver reads rather than as a throw, the way an approved data fix that will not run does.
 */
export function createPullRequestOpener({
  tool,
  repo,
  base,
  branch,
}: PullRequestOpenerOptions): OpenPullRequest {
  return async (request: PullRequestRequest): Promise<PullRequestOpened> => {
    try {
      const result = await tool.invoke({
        ...repo,
        head: branch,
        base,
        title: request.title,
        body: request.body,
      });
      const opened = openedPullRequestOf(result, repo);
      if (opened) return { ok: true, ...opened };
      return {
        ok: false,
        reason: `GitHub did not open a pull request: ${textOf(result) ?? "it answered with nothing"}`,
      };
    } catch (error) {
      return { ok: false, reason: `GitHub refused to open the pull request: ${messageOf(error)}` };
    }
  };
}
