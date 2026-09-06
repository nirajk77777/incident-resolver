import {
  type ApprovalAction,
  approvals,
  type Db,
  type Proposal,
  proposalSchema,
  redact,
} from "@incident-resolver/shared";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { DataFixRunner } from "./data-fix";

/** A `portal.approvals` row. */
export type ApprovalRecord = typeof approvals.$inferSelect;

export type OpenApproval = {
  ticketId: string;
  run: number;
  action: ApprovalAction;
  /** The arguments of the interrupted tool call, as the agent wrote them. */
  args: Record<string, unknown>;
  /** Kept unmasked in the preview; every other Reporter's is masked. */
  reporterEmail?: string | undefined;
};

/** What a Reviewer's answer records, already checked against the action's policy. */
export type RecordedDecision =
  | { decision: "approve" }
  | { decision: "edit"; proposal: Proposal }
  | { decision: "reject"; reason: string };

/**
 * The approval gate's record. One row per Proposal a run stopped on: what was proposed, what
 * it would touch, what the Reviewer decided, and — for a data fix — the rows as they were
 * before it ran. The run itself lives in the LangGraph checkpoint; this is what a human can
 * read afterwards, and what the portal shows on the Ticket.
 */
export type ApprovalStore = {
  /** Opens the Proposal a run has stopped on, with a preview of what it would do. */
  open(request: OpenApproval): Promise<ApprovalRecord>;
  /** The Proposal a Ticket is waiting on, or undefined when it is waiting on none. */
  pending(ticketId: string): Promise<ApprovalRecord | undefined>;
  /** Every Proposal this Ticket has raised, newest first. */
  forTicket(ticketId: string): Promise<ApprovalRecord[]>;
  /**
   * Writes the Reviewer's answer, once. Returns undefined when this Proposal had already
   * been decided, so a second Decision cannot start the run a second time.
   */
  decide(id: string, decision: RecordedDecision): Promise<ApprovalRecord | undefined>;
  /**
   * The approved write this run has still to carry out, which is how the effect that carries
   * it out knows which record to write its result onto.
   */
  awaitingExecution(
    ticketId: string,
    run: number,
    action: ApprovalAction,
  ): Promise<ApprovalRecord | undefined>;
  /** Records what running an approved fix did, and the rows it changed as they were. */
  recordExecution(id: string, result: Record<string, unknown>, snapshot: unknown): Promise<void>;
  /** Whether a data fix this run proposed was approved and actually changed rows. */
  dataFixApplied(ticketId: string, run: number): Promise<boolean>;
  /**
   * The Reply this run had approved, as it was finally worded. The Ticket closes with this
   * rather than with the Verdict's text, so a Reviewer's rewording is what the Reporter reads.
   */
  approvedReply(ticketId: string, run: number): Promise<string | undefined>;
};

export type ApprovalStoreOptions = {
  db: Db;
  /** Reads the rows a data fix would touch, so the card shows them. */
  dataFix: DataFixRunner;
};

export function createApprovalStore({ db, dataFix }: ApprovalStoreOptions): ApprovalStore {
  return {
    async open(request) {
      const { proposal, preview } = await reviewable(
        dataFix,
        proposalFor(request.action, request.args),
        request.reporterEmail,
      );
      const [row] = await db
        .insert(approvals)
        .values({
          ticketId: request.ticketId,
          run: request.run,
          action: request.action,
          proposal,
          preview,
        })
        .returning();
      if (!row) throw new Error("Insert returned no approval");
      return row;
    },

    async pending(ticketId) {
      const [row] = await db
        .select()
        .from(approvals)
        .where(and(eq(approvals.ticketId, ticketId), isNull(approvals.decision)))
        .orderBy(desc(approvals.createdAt))
        .limit(1);
      return row;
    },

    forTicket(ticketId) {
      return db
        .select()
        .from(approvals)
        .where(eq(approvals.ticketId, ticketId))
        .orderBy(desc(approvals.createdAt));
    },

    async decide(id, decision) {
      const [row] = await db
        .update(approvals)
        .set({
          decision: decision.decision,
          editedProposal: decision.decision === "edit" ? decision.proposal : null,
          reason: decision.decision === "reject" ? decision.reason : null,
          decidedAt: new Date(),
        })
        .where(and(eq(approvals.id, id), isNull(approvals.decision)))
        .returning();
      return row;
    },

    async awaitingExecution(ticketId, run, action) {
      const [row] = await db
        .select()
        .from(approvals)
        .where(
          and(
            eq(approvals.ticketId, ticketId),
            eq(approvals.run, run),
            eq(approvals.action, action),
            isNull(approvals.executedAt),
            inArray(approvals.decision, ["approve", "edit"]),
          ),
        )
        .orderBy(desc(approvals.decidedAt))
        .limit(1);
      return row;
    },

    async recordExecution(id, result, snapshot) {
      await db
        .update(approvals)
        .set({ result, snapshot, executedAt: new Date() })
        .where(eq(approvals.id, id));
      return;
    },

    async dataFixApplied(ticketId, run) {
      const rows = await db
        .select({ result: approvals.result })
        .from(approvals)
        .where(
          and(
            eq(approvals.ticketId, ticketId),
            eq(approvals.run, run),
            eq(approvals.action, "apply_data_fix"),
          ),
        );
      return rows.some((row) => row.result?.ran === true);
    },

    async approvedReply(ticketId, run) {
      const [row] = await db
        .select()
        .from(approvals)
        .where(
          and(
            eq(approvals.ticketId, ticketId),
            eq(approvals.run, run),
            eq(approvals.action, "send_customer_reply"),
          ),
        )
        .orderBy(desc(approvals.decidedAt))
        .limit(1);
      if (!row || row.decision === "reject" || row.decision === null) return undefined;
      const settled = settledProposal(row);
      return settled?.kind === "reply" ? settled.text : undefined;
    },
  };
}

/** The Proposal a Decision left standing: the Reviewer's edit if there was one, else the agent's. */
export function settledProposal(approval: ApprovalRecord): Proposal | undefined {
  const source = approval.editedProposal ?? approval.proposal;
  const parsed = proposalSchema.safeParse(source);
  return parsed.success ? parsed.data : undefined;
}

const text = (value: unknown) => (typeof value === "string" ? value : "");

/**
 * The Proposal one gated tool call carries, read off its arguments. A Reply and a pull request
 * are their arguments; a data fix is more, since which table it touches and how many rows it
 * matches are read out of the statement rather than asserted by the agent.
 */
export function proposalFor(action: ApprovalAction, args: Record<string, unknown>): Proposal {
  switch (action) {
    case "apply_data_fix":
      return {
        kind: "data_fix",
        statement: "update",
        table: "",
        sql: text(args.sql),
        reason: text(args.reason),
        matchingRows: null,
        executed: false,
      };
    case "send_customer_reply":
      return { kind: "reply", text: text(args.text) };
    case "create_pull_request":
      return {
        kind: "pull_request",
        branch: text(args.branch),
        title: text(args.title),
        body: text(args.body),
        files: Array.isArray(args.files) ? args.files.map(text) : [],
      };
  }
}

/** What the Reviewer sees: the Proposal, and for a data fix the rows it would touch. */
type Reviewable = { proposal: Proposal; preview: Record<string, unknown> | null };

/**
 * Completes a Proposal with what the database says about it. For a data fix that is the rows it
 * matches, read as they are now and masked the way every other tool result is, plus the table
 * and statement the guard read out of the SQL — so the card names them whoever wrote it, and a
 * statement the guard would refuse says so on the card instead of at execution time. A Reply
 * and a pull request are already the whole of what there is to review.
 */
async function reviewable(
  dataFix: DataFixRunner,
  proposal: Proposal,
  reporterEmail: string | undefined,
): Promise<Reviewable> {
  if (proposal.kind !== "data_fix") return { proposal, preview: null };
  const matched = await dataFix.preview(proposal.sql);
  if (!matched.ok) return { proposal, preview: { refused: matched.reason } };
  return {
    proposal: {
      ...proposal,
      statement: matched.statement,
      table: matched.table,
      matchingRows: matched.rowCount,
    },
    preview: {
      table: matched.table,
      rowCount: matched.rowCount,
      rows: redact(matched.rows, { reporterEmail }),
    },
  };
}
