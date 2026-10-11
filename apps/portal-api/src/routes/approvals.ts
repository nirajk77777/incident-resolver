import {
  allowedDecisions,
  type Decision,
  formatIssues,
  isApprovalAction,
  reviewerDecisionSchema,
} from "@incident-resolver/shared";
import type { FastifyInstance } from "fastify";
import type { ApprovalRecord } from "../approvals/approvals";
import { requireTicket } from "../http/ticket-param";
import type { PortalServices } from "../server";

/**
 * An approval as the portal serves it. The snapshot of changed rows stays behind: it exists so
 * a person with database access can undo a fix, and it is the one thing here that was never
 * masked, since a rollback needs the rows as they truly were.
 */
function approvalBody(approval: ApprovalRecord) {
  return {
    id: approval.id,
    run: approval.run,
    action: approval.action,
    allowedDecisions: isApprovalAction(approval.action)
      ? allowedDecisions[approval.action]
      : ([] as readonly Decision[]),
    proposal: approval.proposal,
    preview: approval.preview,
    decision: approval.decision,
    editedProposal: approval.editedProposal,
    reason: approval.reason,
    result: approval.result,
    createdAt: approval.createdAt,
    decidedAt: approval.decidedAt,
    executedAt: approval.executedAt,
  };
}

/** The approval gate: the Proposals a Ticket has raised, and the Reviewer's Decision on one. */
export async function approvalRoutes(
  app: FastifyInstance,
  { store, approvals, runner }: PortalServices,
): Promise<void> {
  /**
   * The Proposals this Ticket has raised, newest first, and what became of each. The card the
   * Reviewer decides on is drawn from the newest undecided one.
   */
  app.get("/tickets/:id/approvals", async (request, reply) => {
    const ticket = await requireTicket(store, request, reply);
    if (!ticket) return;
    return { approvals: (await approvals.forTicket(ticket.id)).map(approvalBody) };
  });

  /**
   * A Reviewer's Decision on the Proposal a Ticket is waiting on. Recording it carries the run
   * on in the background, so this answers as soon as the Decision is safely written; what the
   * run then does arrives on the timeline like everything else.
   */
  app.post("/tickets/:id/decision", async (request, reply) => {
    const ticket = await requireTicket(store, request, reply);
    if (!ticket) return;

    const answer = reviewerDecisionSchema.safeParse(request.body);
    if (!answer.success) {
      return reply.code(400).send({ error: "Bad Request", message: formatIssues(answer.error) });
    }
    const result = await runner.decide(ticket, answer.data);
    if (!result.ok) {
      const error = result.status === 400 ? "Bad Request" : "Conflict";
      return reply.code(result.status).send({ error, message: result.message });
    }
    return reply.code(202).send({ approval: approvalBody(result.approval) });
  });
}
