import { messageOf } from "@incident-resolver/shared";
import type { Anomaly } from "./detect";
import type { Evidence } from "./evidence";

/**
 * Putting the finding into words. This is the only part of Sentinel a model touches, and it
 * touches only the wording: the route, the ratio and the trace ids are attached here from
 * what was measured, so a Ticket can never carry a number or an id the model invented. A
 * Sentinel with no model — or one whose model will not answer — still opens the Ticket.
 */

export type TicketText = { title: string; body: string };

const percent = (ratio: number) => `${Math.round(ratio * 100)}%`;

/** The facts as text: what the model is given, and what the plain wording is built from. */
export function sentinelBrief(anomaly: Anomaly, evidence: Evidence): string {
  const codes = Object.entries(anomaly.byStatusCode)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([code, count]) => `${code}: ${count}`)
    .join(", ");
  const lines = [
    `Route: ${anomaly.route}`,
    `Window: the last ${anomaly.window}`,
    `Requests: ${anomaly.requests} requests, ${anomaly.serverErrors} of them server errors`,
    `Server error ratio: ${percent(anomaly.serverErrorRate)}`,
    `Responses by status code: ${codes}`,
  ];
  if (evidence.messages.length > 0) {
    lines.push("Log lines in the window, most frequent first:");
    for (const entry of evidence.messages) {
      lines.push(`  ${entry.count}x [${entry.level ?? "unknown"}] ${entry.message}`);
    }
  } else {
    lines.push("No warn-or-above log lines were found in the window.");
  }
  return lines.join("\n");
}

/** The trace ids, as the line appended to every body. Empty when Loki gave none. */
function traceIdLine(evidence: Evidence): string {
  return evidence.traceIds.length === 0 ? "" : `\n\nTrace ids: ${evidence.traceIds.join(", ")}`;
}

/** The Ticket Sentinel opens when no model words it: the brief, stated plainly. */
export function plainTicketText(anomaly: Anomaly, evidence: Evidence): TicketText {
  return {
    title: `${percent(anomaly.serverErrorRate)} of ${anomaly.route} requests are failing`,
    body:
      `Sentinel saw ${anomaly.serverErrors} of ${anomaly.requests} requests to ${anomaly.route} ` +
      `fail with a server error over the last ${anomaly.window}.\n\n${sentinelBrief(anomaly, evidence)}` +
      traceIdLine(evidence),
  };
}

/** Turns the brief into a title and a body. The model, when there is one. */
export type TicketComposer = (brief: string) => Promise<TicketText>;

export type TicketWriter = (anomaly: Anomaly, evidence: Evidence) => Promise<TicketText>;

export type TicketWriterOptions = {
  /** Absent when no model is configured, which is a supported way to run Sentinel. */
  compose?: TicketComposer | undefined;
  /** Told why the plain wording was used instead. Sentinel opens the Ticket either way. */
  onFallback?: ((reason: string) => void) | undefined;
};

export function createTicketWriter({ compose, onFallback }: TicketWriterOptions): TicketWriter {
  return async (anomaly, evidence) => {
    const plain = plainTicketText(anomaly, evidence);
    if (!compose) return plain;
    try {
      const written = await compose(sentinelBrief(anomaly, evidence));
      const title = written.title.trim();
      const body = written.body.trim();
      if (!title || !body) {
        onFallback?.("the model returned an empty title or body");
        return plain;
      }
      return { title, body: body + traceIdLine(evidence) };
    } catch (error) {
      onFallback?.(messageOf(error));
      return plain;
    }
  };
}
