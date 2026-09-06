import {
  type ErrorRate,
  errorRateByRouteQuery,
  errorRatesByRoute,
  type LokiClient,
  type PrometheusClient,
} from "@incident-resolver/mcp-observability";
import { messageOf } from "@incident-resolver/shared";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { type Anomaly, anomaliesIn, type SentinelThresholds, windowOf } from "./detect";
import { type Evidence, gatherEvidence } from "./evidence";
import type { OpenedTicket, PortalClient } from "./portal";
import type { TicketText, TicketWriter } from "./ticket-text";

/**
 * Sentinel as a graph: watch, and if a route is in trouble, gather what was in the logs,
 * word it, and open a Ticket. One pass over the graph is one poll; `main.ts` runs it on
 * `SENTINEL_POLL_INTERVAL_MS`, so a pass that overruns cannot overlap the next one.
 *
 * It is a plain LangGraph rather than a deep agent because there is nothing to plan: the
 * rule is arithmetic (see `detect.ts`) and the only thing a model is trusted with is the
 * wording. Every step is a node so a pass shows up in a trace as the four things it did.
 */

const SentinelState = Annotation.Root({
  /** Every failing route this pass saw, worst first. Kept for the run report. */
  rates: Annotation<ErrorRate[]>({ reducer: (_, next) => next, default: () => [] }),
  /** The worst route over the threshold, or null when nothing is wrong. */
  anomaly: Annotation<Anomaly | null>({ reducer: (_, next) => next, default: () => null }),
  evidence: Annotation<Evidence | null>({ reducer: (_, next) => next, default: () => null }),
  text: Annotation<TicketText | null>({ reducer: (_, next) => next, default: () => null }),
  opened: Annotation<OpenedTicket | null>({ reducer: (_, next) => next, default: () => null }),
  /** What could not be read this pass. A pass says what it is missing rather than pretending. */
  warnings: Annotation<string[]>({ reducer: (_, next) => next, default: () => [] }),
});

export type SentinelPass = typeof SentinelState.State;

export type SentinelDeps = {
  prometheus: PrometheusClient;
  loki: LokiClient;
  portal: PortalClient;
  /** Puts the finding into words. See `ticket-text.ts`; a model is optional. */
  writeTicket: TicketWriter;
  thresholds: SentinelThresholds;
  /** ShopLite's service.name: Prometheus's `job` and Loki's `service_name`. */
  serviceName: string;
};

export function createSentinelGraph(deps: SentinelDeps) {
  const window = windowOf(deps.thresholds);

  return new StateGraph(SentinelState)
    .addNode("watch", async () => {
      const vector = await deps.prometheus.query(errorRateByRouteQuery(deps.serviceName, window));
      const rates = errorRatesByRoute(vector, window);
      return { rates, anomaly: anomaliesIn(rates, deps.thresholds)[0] ?? null };
    })
    .addNode("gather", async (state) => {
      // Metrics say a route is failing; the logs say what it said while failing, and carry
      // the trace ids the investigation starts from. A Loki that is down costs the Ticket
      // its trace ids, not its existence.
      try {
        return {
          evidence: await gatherEvidence(deps.loki, {
            serviceName: deps.serviceName,
            since: state.anomaly?.window ?? window,
          }),
        };
      } catch (error) {
        return {
          evidence: { traceIds: [], messages: [] },
          warnings: [`Logs unavailable: ${messageOf(error)}`],
        };
      }
    })
    .addNode("compose", async (state) => {
      if (!state.anomaly || !state.evidence) return {};
      return { text: await deps.writeTicket(state.anomaly, state.evidence) };
    })
    .addNode("open", async (state) => {
      if (!state.anomaly || !state.text) return {};
      return {
        opened: await deps.portal.openTicket({
          source: "sentinel",
          title: state.text.title,
          body: state.text.body,
          fingerprint: state.anomaly.fingerprint,
          // The newest failing request, so the Ticket links straight to a real trace.
          ...(state.evidence?.traceIds[0] ? { traceId: state.evidence.traceIds[0] } : {}),
        }),
      };
    })
    .addEdge(START, "watch")
    .addConditionalEdges("watch", (state) => (state.anomaly ? "gather" : END), ["gather", END])
    .addEdge("gather", "compose")
    .addEdge("compose", "open")
    .addEdge("open", END)
    .compile();
}

/** One poll: what Sentinel saw, and what it did about it. */
export async function runSentinelPass(deps: SentinelDeps): Promise<SentinelPass> {
  return createSentinelGraph(deps).invoke({});
}
