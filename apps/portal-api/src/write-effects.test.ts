import type { PullRequestRequest } from "@incident-resolver/agents";
import type { FastifyBaseLogger } from "fastify";
import { describe, expect, it } from "vitest";
import type { ApprovalRecord, ApprovalStore } from "./approvals";
import type { DataFixRunner } from "./data-fix";
import type { TimelineWriter } from "./timeline";
import { createWriteEffects } from "./write-effects";

/**
 * What the portal does with an approved pull request. Opening it on GitHub has already
 * happened by the time the effect runs — that call belongs to the run that holds the MCP
 * client — so what is checked here is the portal's half: that nothing is recorded without an
 * approval behind it, that the result goes onto the approval record, and that the link
 * reaches the Ticket as an internal note and never as the Reply.
 */

const ticketId = "3f7c1b52-8f0f-4a9f-9b1a-2c9d5e6f7a80";

const branch = `fix/ticket-${ticketId}`;

const request: PullRequestRequest = {
  title: "fix: apply the percentage discount once per order",
  body: "## Root cause\nIt is applied twice.",
  files: ["apps/api/src/domain/order.ts", "apps/api/src/domain/order.test.ts"],
};

const opened = { ok: true, url: "https://github.com/n/s/pull/9", number: 9 } as const;

type Recorded = { id: string; result: Record<string, unknown> };
type Note = { ticketId: string; run: number; type: string; payload: Record<string, unknown> };

const approval = {
  id: "approval-1",
  proposal: { kind: "pull_request", branch, title: "t", body: "b", files: [] },
} as unknown as ApprovalRecord;

function harness({ awaiting }: { awaiting: ApprovalRecord | undefined } = { awaiting: approval }) {
  const recorded: Recorded[] = [];
  const notes: Note[] = [];
  const approvals = {
    async awaitingExecution() {
      return awaiting;
    },
    async recordExecution(id: string, result: Record<string, unknown>) {
      recorded.push({ id, result });
    },
  } as unknown as ApprovalStore;
  const record: TimelineWriter = async (id, run, entry) => {
    notes.push({ ticketId: id, run, ...entry });
  };
  const log = { info() {}, warn() {}, error() {} } as unknown as FastifyBaseLogger;
  const effects = createWriteEffects({
    approvals,
    dataFix: {} as DataFixRunner,
    record,
    log,
  })(ticketId, 1);
  return { effects, recorded, notes };
}

describe("an approved pull request", () => {
  it("records what GitHub opened on the approval it was opened under", async () => {
    const { effects, recorded } = harness();

    await effects.createPullRequest(request, opened);

    expect(recorded).toEqual([
      {
        id: "approval-1",
        result: { opened: true, url: opened.url, number: 9, branch },
      },
    ]);
  });

  it("puts the link on the Ticket as an internal note", async () => {
    const { effects, notes } = harness();

    await effects.createPullRequest(request, opened);

    expect(notes).toEqual([
      {
        ticketId,
        run: 1,
        type: "message",
        payload: {
          text: `Pull request opened on ${branch}: ${opened.url}`,
          reason: "pull_request",
          url: opened.url,
          branch,
          files: request.files,
        },
      },
    ]);
  });

  it("tells the Resolver where it is, and that the link is not for the Reply", async () => {
    const { effects } = harness();

    const said = await effects.createPullRequest(request, opened);

    expect(said).toContain(opened.url);
    expect(said).toMatch(/not put it in the Reply/);
  });
});

describe("a pull request that did not open", () => {
  const refused = { ok: false, reason: "422 Validation Failed: no commits between" } as const;

  it("records the refusal rather than a pull request nobody can find", async () => {
    const { effects, recorded, notes } = harness();

    const said = await effects.createPullRequest(request, refused);

    expect(recorded[0]?.result).toEqual({ opened: false, reason: refused.reason });
    expect(notes).toEqual([]);
    expect(said).toContain(refused.reason);
  });
});

describe("a pull request with no approval behind it", () => {
  it("records nothing and says so, because no Reviewer agreed to it", async () => {
    const { effects, recorded, notes } = harness({ awaiting: undefined });

    const said = await effects.createPullRequest(request, opened);

    expect(recorded).toEqual([]);
    expect(notes).toEqual([]);
    expect(said).toMatch(/no approved Proposal/);
  });
});
