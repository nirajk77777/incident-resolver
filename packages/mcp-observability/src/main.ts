import { messageOf } from "@incident-resolver/shared";
import { getConfig } from "@incident-resolver/shared/config";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLokiClient } from "./loki";
import { createPrometheusClient } from "./prometheus";
import { createObservabilityServer } from "./server";
import { createTempoClient } from "./tempo";

/**
 * Stdio entry point, spawned by portal-api per Ticket.
 *
 * Environment: LOKI_URL, TEMPO_URL, PROMETHEUS_URL, SHOPLITE_SERVICE_NAME, and LOG_LINE_CAP
 * from the shared config, plus REPORTER_EMAIL for customer Tickets so the reporter's own
 * email stays visible in log lines. Leave it unset for tester and Sentinel Tickets. The
 * reporter is read straight from the environment rather than config.ts because it is
 * per-Ticket spawn context, not a tunable.
 */
const config = getConfig();
const reporterEmail = process.env.REPORTER_EMAIL || undefined;

try {
  const server = createObservabilityServer({
    loki: createLokiClient(config.infra.lokiUrl),
    tempo: createTempoClient(config.infra.tempoUrl),
    prometheus: createPrometheusClient(config.infra.prometheusUrl),
    serviceName: config.shopliteServiceName,
    lineCap: config.logLineCap,
    reporterEmail,
  });
  await server.connect(new StdioServerTransport());
  console.error(
    `mcp-observability ready for ${config.shopliteServiceName}` +
      (reporterEmail ? `, reporter ${reporterEmail}` : ", unscoped"),
  );
} catch (error) {
  console.error(`mcp-observability failed to start: ${messageOf(error)}`);
  process.exit(1);
}
