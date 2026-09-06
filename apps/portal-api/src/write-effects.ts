import type { WriteEffects } from "@incident-resolver/agents";
import type { FastifyBaseLogger } from "fastify";
import type { ApprovalStore } from "./approvals";
import type { DataFixRunner } from "./data-fix";

export type WriteEffectsOptions = {
  approvals: ApprovalStore;
  dataFix: DataFixRunner;
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
 * approval record, and it is what the Ticket closes with.
 */
export function createWriteEffects({ approvals, dataFix, log }: WriteEffectsOptions) {
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

    async sendCustomerReply({ text }) {
      // Delivery is a stub: the Reply reaches the Reporter through the storefront's own
      // "My tickets" page, which reads it off the Ticket once the run closes it.
      log.info({ ticketId, run }, "The Reply was sent to the Reporter");
      return `Sent. The Reporter will read exactly this: ${text}`;
    },
  });
}
