/**
 * Where a Ticket points out to. Both pipelines are OpenTelemetry, so a Ticket carries two
 * trace ids: the ShopLite request the Reporter hit, in Grafana, and the Resolver run that
 * investigated it, in Langfuse. The portal serves both base URLs from its own config.
 */

/** The Tempo datasource the `grafana/otel-lgtm` image provisions, alongside loki and prometheus. */
export const TEMPO_DATASOURCE_UID = "tempo";

const trimmed = (baseUrl: string) => baseUrl.replace(/\/+$/, "");

/**
 * One Resolver run in Langfuse. `/trace/:id` resolves the project itself, so the portal
 * needs no project id in its configuration.
 */
export function langfuseTraceUrl(baseUrl: string, traceId: string): string {
  return `${trimmed(baseUrl)}/trace/${encodeURIComponent(traceId)}`;
}

/** One ShopLite request in Grafana, opened in Explore against Tempo as a TraceQL lookup. */
export function grafanaTraceUrl(baseUrl: string, traceId: string): string {
  const pane = {
    shoplite: {
      datasource: TEMPO_DATASOURCE_UID,
      queries: [
        {
          refId: "A",
          datasource: { type: "tempo", uid: TEMPO_DATASOURCE_UID },
          queryType: "traceql",
          query: traceId,
        },
      ],
      range: { from: "now-6h", to: "now" },
    },
  };
  const query = new URLSearchParams({
    schemaVersion: "1",
    orgId: "1",
    panes: JSON.stringify(pane),
  });
  return `${trimmed(baseUrl)}/explore?${query.toString()}`;
}
