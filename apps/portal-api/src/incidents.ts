import type { Embedder, KnowledgeStore, NewIncident } from "@incident-resolver/mcp-incidents";
import { incidentDocument } from "@incident-resolver/mcp-incidents";
import {
  BY_AGENT,
  BY_HUMAN,
  type ManualResolution,
  messageOf,
  type Outcome,
  type Verdict,
} from "@incident-resolver/shared";
import type { FastifyBaseLogger } from "fastify";
import type { TicketRecord } from "./store";

/**
 * The Incident a closed Ticket leaves in the knowledge base, so the next similar Ticket finds
 * it. Both kinds are derived here rather than asked of a model: an agent-resolved Ticket from
 * its Verdict, a human-resolved one from what the Reviewer wrote. What differs between them is
 * only who resolved it, which is what the record says.
 */

/** As much of a Ticket as an Incident is written from. */
export type IncidentSource = Pick<TicketRecord, "id" | "title" | "body" | "category">;

/** What one line of the resolution says the Ticket ended as, before the Reply that says it in words. */
const outcomeResolutions: Record<Outcome, string> = {
  answered: "Answered from the Evidence; nothing in the product was changed.",
  data_fixed: "An approved data fix corrected the rows.",
  fix_proposed: "A pull request with the fix was opened.",
  escalated: "Handed to a human.",
};

/**
 * What settled the Ticket, in the words a future search will match on. Kept on the Ticket as
 * well as on the Incident, so the portal can show it without reading the knowledge base.
 */
export function resolutionOf(verdict: Verdict): string {
  return `${outcomeResolutions[verdict.outcome]}\n\n${verdict.reply}`;
}

/**
 * What the Reporter saw, with the Evidence that confirmed it. The Ticket body is the symptom
 * in the Reporter's own words, which is what the next Reporter will describe it as, and each
 * Evidence reference keeps its provenance so a match can be checked rather than believed.
 */
function symptomsOf(ticket: IncidentSource, evidence: Verdict["evidence"]): string {
  const facts = evidence.map((item) => `- ${item.fact} (${item.provenance})`);
  return [ticket.body, ...facts].join("\n");
}

/** The Incident an agent-resolved Ticket leaves behind, derived from its Verdict at close. */
export function incidentFromVerdict(ticket: IncidentSource, verdict: Verdict): NewIncident {
  return {
    title: ticket.title,
    symptoms: symptomsOf(ticket, verdict.evidence),
    rootCause: verdict.rootCause,
    resolution: resolutionOf(verdict),
    category: verdict.category,
    sourceTicketId: ticket.id,
    resolvedBy: BY_AGENT,
    author: "Resolver",
  };
}

/**
 * The Incident a Reviewer's manual resolution leaves behind. The Category is the one Triage
 * settled on before the run escalated; a run that never got that far leaves it `unknown`,
 * which is what it was.
 */
export function incidentFromResolution(
  ticket: IncidentSource,
  resolution: ManualResolution,
): NewIncident {
  return {
    title: ticket.title,
    symptoms: ticket.body,
    rootCause: resolution.rootCause,
    resolution: resolution.resolution,
    category: ticket.category ?? "unknown",
    sourceTicketId: ticket.id,
    resolvedBy: BY_HUMAN,
    author: resolution.author,
  };
}

/**
 * Where a closed Ticket's Incident is written. Failing to write one must never stop a Ticket
 * from closing: the Reporter's answer does not depend on the knowledge base, and a Ticket left
 * mid-lifecycle because Cohere was slow is a worse failure than a record nobody wrote.
 */
export type IncidentWriter = {
  write(incident: NewIncident): Promise<void>;
};

export type IncidentWriterOptions = {
  store: KnowledgeStore;
  embedder: Embedder;
  log: FastifyBaseLogger;
};

export function createIncidentWriter({
  store,
  embedder,
  log,
}: IncidentWriterOptions): IncidentWriter {
  return {
    async write(incident) {
      try {
        const [embedding] = await embedder.embedDocuments([incidentDocument(incident)]);
        if (!embedding) throw new Error("the embedder returned no vector");
        // One Incident per Ticket: a re-run, or a Reviewer resolving what a run escalated,
        // replaces what was there rather than leaving the knowledge base holding both.
        const ticketId = incident.sourceTicketId;
        if (ticketId) await store.deleteIncidentsForTicket(ticketId);
        const saved = await store.insertIncident(incident, embedding);
        log.info(
          { ticketId, incidentId: saved.id, resolvedBy: saved.resolvedBy },
          "Wrote the Incident a closed Ticket left behind",
        );
      } catch (error) {
        log.error(
          { ticketId: incident.sourceTicketId, err: error },
          `Could not write the Incident for a closed Ticket: ${messageOf(error)}`,
        );
      }
    },
  };
}

/** What a portal with no Cohere key writes: nothing. Every other part of a close still runs. */
export const noIncidents: IncidentWriter = { write: async () => {} };
