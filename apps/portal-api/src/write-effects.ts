import type { WriteEffects } from "@incident-resolver/agents";
import type { FastifyBaseLogger } from "fastify";
import { type ApprovalStore, settledProposal } from "./approvals";
import type { DataFixRunner } from "./data-fix";
import type { TimelineWriter } from "./timeline";

export type WriteEffectsOptions = {
  approvals: ApprovalStore;
  dataFix: DataFixRunner;
  /** Writes an entry onto a Ticket's Timeline, which is where the internal note goes. */
  record: TimelineWriter;
  log: FastifyBaseLogger;
};

/**
 * What the portal does when a Proposal is approved, and the only writes the agent's side of
 * the system can reach. Each of these runs inside the tool the Reviewer approved, so what it
 * returns is what the Resolver then reads: a Verdict of `data_fixed` is written by an agent
 * that was told the rows changed.
 *
 * The data fix goes through the writing role, in a transaction, under the row cap, and the
 * rows as they were are written onto the approval so a person can put them back. Delivering a
 * Reply is a stub that logs (PLAN.md section 4); the approved wording is already on the
 * approval record, and it is what the Ticket closes with. The pull request has already been
 * opened on GitHub by the time it reaches here — that call is the agent package's, since it
 * holds the run's MCP client — so what the portal does with it is record it: on the approval,
 * and as an internal note on the Ticket carrying the link.
 */
export function createWriteEffects({ approvals, dataFix, record, log }: WriteEffectsOptions) {
  return (ticketId: string, run: number): WriteEffects => ({
    async applyDataFix({ sql }) {
      // The approval the write runs under is found first, and nothing is written without one.
      // A tool reaching here with no approved Proposal behind it would be a write no Reviewer
      // agreed to, which is the one thing the gate exists to prevent; it would also leave the
      // rows it changed unrecorded, so there would be nothing to put them back from.
      const approval = await approvals.awaitingExecution(ticketId, run, "apply_data_fix");
      if (!approval) {
        log.error({ ticketId, run }, "A data fix asked to run with no approved Proposal behind it");
        return (
          "The fix did not run and nothing was changed: the portal has no approved Proposal " +
          "to run it under."
        );
      }

      const applied = await dataFix.apply(sql);
      if (!applied.ok) {
        log.warn({ ticketId, run, reason: applied.reason }, "An approved data fix did not run");
        await approvals.recordExecution(approval.id, { ran: false, reason: applied.reason }, null);
        return `The fix did not run and nothing was changed. ${applied.reason}`;
      }

      // The ShopLite write and this record cannot be one transaction: they are made by two
      // roles, and the writing one has no privilege in the portal schema, which is the point.
      // So a crash between them would leave a corrected row with no snapshot beside it — the
      // window is one statement wide, and the alternative is a role that can write both.
      await approvals.recordExecution(
        approval.id,
        {
          ran: true,
          statement: applied.statement,
          table: applied.table,
          rowCount: applied.rowCount,
        },
        applied.snapshot,
      );
      log.info(
        { ticketId, run, table: applied.table, rowCount: applied.rowCount },
        "An approved data fix ran",
      );
      return (
        `The fix ran. ${applied.rowCount} row(s) of ${applied.table} were corrected by the ` +
        `${applied.statement.toUpperCase()}, and the rows as they were have been kept so it can be undone.`
      );
    },

    async createPullRequest(request, opened) {
      // The same rule as the data fix: nothing is recorded as done without the approval it
      // was done under. A pull request reaching here with none behind it would be one no
      // Reviewer agreed to, and the link would go onto the Ticket as though they had.
      const approval = await approvals.awaitingExecution(ticketId, run, "create_pull_request");
      if (!approval) {
        log.error(
          { ticketId, run },
          "A pull request asked to be opened with no approved Proposal behind it",
        );
        return (
          "The pull request was not recorded: the portal has no approved Proposal to open it " +
          "under. Say so in rootCause and escalate."
        );
      }

      if (!opened.ok) {
        log.warn({ ticketId, run, reason: opened.reason }, "An approved pull request did not open");
        await approvals.recordExecution(
          approval.id,
          { opened: false, reason: opened.reason },
          null,
        );
        return `The pull request was not opened. ${opened.reason}`;
      }

      // The branch the Reviewer approved, off the Proposal they saw, rather than one derived a
      // second time here: the card and the record then cannot disagree about what was opened.
      const settled = settledProposal(approval);
      const branch = settled?.kind === "pull_request" ? settled.branch : "";
      await approvals.recordExecution(
        approval.id,
        { opened: true, url: opened.url, number: opened.number, branch },
        null,
      );
      // The internal note. The Reply the Reporter reads never carries the link (CONTEXT.md's
      // fix proposed Outcome), so this is where the team picks the pull request up.
      await record(ticketId, run, {
        type: "message",
        payload: {
          text: `Pull request opened on ${branch}: ${opened.url}`,
          reason: "pull_request",
          url: opened.url,
          branch,
          files: request.files,
        },
      });
      log.info({ ticketId, run, url: opened.url }, "An approved pull request was opened");
      return (
        `The pull request is open at ${opened.url}, from ${branch} with ` +
        `${request.files.length} changed file(s). The link is on the Ticket as an internal note, ` +
        "so do not put it in the Reply."
      );
    },

    async sendCustomerReply({ text }) {
      // Delivery is a stub: the Reply reaches the Reporter through the storefront's own
      // "My tickets" page, which reads it off the Ticket once the run closes it.
      log.info({ ticketId, run }, "The Reply was sent to the Reporter");
      return `Sent. The Reporter will read exactly this: ${text}`;
    },
  });
}
