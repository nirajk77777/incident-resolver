import { describe, expect, it } from "vitest";
import { proposalFor } from "./approvals";

/**
 * The Proposal a Reviewer is shown, read off the gated tool call. The branch is the one thing
 * on a pull request card that is not the agent's to assert: the run stops on the tool call as
 * the model wrote it, so a branch it had copied by hand would put a Reviewer in front of a
 * name rather than a branch. It is derived from the Ticket here, the same way the Fix Shipper
 * derived it when it pushed.
 */

const ticketId = "3f7c1b52-8f0f-4a9f-9b1a-2c9d5e6f7a80";

describe("proposalFor a pull request", () => {
  it("names this Ticket's branch, whatever the agent's arguments said", () => {
    const proposal = proposalFor(
      "create_pull_request",
      {
        branch: "fix/ticket-typo",
        title: "fix: apply the discount once",
        body: "## Root cause",
        files: ["apps/api/src/domain/order.ts"],
      },
      ticketId,
    );

    expect(proposal).toEqual({
      kind: "pull_request",
      branch: `fix/ticket-${ticketId}`,
      title: "fix: apply the discount once",
      body: "## Root cause",
      files: ["apps/api/src/domain/order.ts"],
    });
  });

  it("names it even when the arguments carried no branch at all, which is the usual case", () => {
    const proposal = proposalFor(
      "create_pull_request",
      { title: "t", body: "b", files: [] },
      ticketId,
    );

    expect(proposal).toMatchObject({ branch: `fix/ticket-${ticketId}` });
  });
});
