import type { StructuredTool } from "@langchain/core/tools";
import { tool } from "langchain";
import { z } from "zod";

/**
 * The Resolver's three write tools, and the only ones it has. Everything else the Resolver and
 * its subagents can reach reads. Each of these is a gated action (PLAN.md section 5): the graph
 * is interrupted before it runs, the Proposal goes to a Reviewer, and the tool runs only on a
 * Decision — so the tool body itself is the approved write, not a proposal of one.
 *
 * What the write actually does is injected: the portal supplies effects that run the fix
 * through the writing role and record the Reply, and the command line supplies effects that
 * write nothing. The agent package never touches ShopLite data itself.
 */

export const APPLY_DATA_FIX = "apply_data_fix";
export const SEND_CUSTOMER_REPLY = "send_customer_reply";
export const CREATE_PULL_REQUEST = "create_pull_request";

export type DataFixRequest = {
  /** One UPDATE or DELETE with a WHERE clause on a ShopLite table. */
  sql: string;
  /** Why this fix is right, with the Evidence behind it. Shown to the Reviewer. */
  reason: string;
};

export type ReplyRequest = { text: string };

/**
 * The pull request the Resolver asked for. The branch is not here: it is derived from the
 * Ticket id on both sides of the gate, so what a Reviewer approves and what GitHub is asked
 * for are the branch the patch is actually on rather than a string that went through a model.
 */
export type PullRequestRequest = {
  title: string;
  /** The RCA: root cause, the failing test, and the fix. */
  body: string;
  /** The files the branch carries, for the Reviewer to see what is in it. */
  files: string[];
};

/** What GitHub did when the approved pull request was opened. */
export type PullRequestOpened =
  | { ok: true; url: string; number: number }
  | { ok: false; reason: string };

/**
 * Opens the pull request on GitHub. Supplied by whoever built the run, since reaching GitHub
 * means holding this run's MCP client; the tool below calls it only once a Reviewer has said
 * so, and hands what it answered to the effects, which are what record it.
 */
export type OpenPullRequest = (request: PullRequestRequest) => Promise<PullRequestOpened>;

/** What the caller does when a Proposal is approved. Each returns what the model then reads. */
export type WriteEffects = {
  applyDataFix(request: DataFixRequest): Promise<string>;
  sendCustomerReply(request: ReplyRequest): Promise<string>;
  /**
   * Records what opening the pull request did — on the approval, and as an internal note on
   * the Ticket carrying the link — and answers the Resolver. The call to GitHub has already
   * happened by the time this runs: `opened` is what it said.
   */
  createPullRequest(request: PullRequestRequest, opened: PullRequestOpened): Promise<string>;
};

/**
 * The opener for a run that has no GitHub MCP server: no token configured, or a portal with
 * no ShopLite repository. The tool still exists and is still gated, so the refusal a Reviewer's
 * approval runs into says what is missing rather than the Resolver finding no tool to call.
 */
export const noGithubOpener: OpenPullRequest = async () => ({
  ok: false,
  reason:
    "This run has no GitHub MCP server, so there was nowhere to open the pull request. Say so " +
    "in rootCause and escalate: the patch is in the Workspace and a person can pick it up.",
});

const dataFixArgs = z.object({
  sql: z
    .string()
    .min(1)
    .describe(
      "The single UPDATE or DELETE with a WHERE clause that corrects the data, copied from the Proposal or the Incident that documents it",
    ),
  reason: z
    .string()
    .min(1)
    .describe(
      "Why this is the right fix, naming the Evidence the Reviewer should check it against",
    ),
});

const pullRequestArgs = z.object({
  title: z.string().min(1).describe("The pull request's title, copied from the Fix Shipper"),
  body: z
    .string()
    .min(1)
    .describe(
      "The pull request's body: the RCA, with the root cause, the failing test, and the fix",
    ),
  files: z
    .array(z.string().min(1))
    .describe("The files the branch carries, copied from the Fix Shipper"),
});

const replyArgs = z.object({
  text: z
    .string()
    .min(1)
    .describe("The Reply as the Reporter will read it, in full: no placeholders, no notes"),
});

/**
 * The three tools, with the one call that reaches GitHub bound in. `open` runs inside the
 * approved tool and never before it, so a Proposal a Reviewer has not answered opens nothing.
 */
export function createWriteTools(effects: WriteEffects, open: OpenPullRequest): StructuredTool[] {
  return [
    tool(async (args: z.infer<typeof dataFixArgs>) => effects.applyDataFix(args), {
      name: APPLY_DATA_FIX,
      description:
        "Corrects wrong ShopLite data. A human Reviewer sees the statement and the rows it would " +
        "touch first, and approves, edits, or rejects it; only then does it run, in a transaction, " +
        "with the rows kept as they were so it can be undone. Call it once you are sure which rows " +
        "are wrong, and read the result: it says what actually changed.",
      schema: dataFixArgs,
    }),
    tool(async (args: z.infer<typeof replyArgs>) => effects.sendCustomerReply(args), {
      name: SEND_CUSTOMER_REPLY,
      description:
        "Sends the Reply to the Reporter. For a customer Ticket a human Reviewer reads it first and " +
        "approves or rewords it. Call it once, with the finished Reply, before returning the Verdict, " +
        "and carry the text the result reports back into the Verdict unchanged.",
      schema: replyArgs,
    }),
    tool(
      async (args: z.infer<typeof pullRequestArgs>) =>
        effects.createPullRequest(args, await open(args)),
      {
        name: CREATE_PULL_REQUEST,
        description:
          "Opens the pull request on ShopLite's repository from the branch the Fix Shipper pushed. " +
          "The branch is this Ticket's own and is filled in for you, so it takes only the title, the " +
          "body, and the files. A human Reviewer sees all of it first and approves or rejects; nothing " +
          "is opened unless they approve. Call it once the Fix Shipper reports the push succeeded, " +
          "with its title, body, and files unchanged, and read the result: it says whether the pull " +
          "request exists and where.",
        schema: pullRequestArgs,
      },
    ),
  ];
}
