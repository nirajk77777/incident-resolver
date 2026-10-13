import { messageOf, type Reporter, resolveReporter } from "@incident-resolver/shared";
import { getConfig } from "@incident-resolver/shared/config";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Pool } from "pg";
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

/**
 * The reporter's customer id, looked up once through the SELECT-only role. ShopLite's logs
 * name a customer by id in the request url, never by email, so this is what a search for the
 * reporter's requests has to use. It only helps a search: if the lookup fails the server
 * still starts, with the email alone, rather than leaving the Ticket without its logs.
 */
async function lookUpReporter(email: string | undefined): Promise<Reporter | undefined> {
  if (!email) return undefined;
  const pool = new Pool({ connectionString: config.infra.shopliteReadonlyDatabaseUrl, max: 1 });
  try {
    return await resolveReporter(pool, { email });
  } catch (error) {
    console.error(`mcp-observability could not look up the reporter: ${messageOf(error)}`);
    return undefined;
  } finally {
    await pool.end();
  }
}

try {
  const reporter = await lookUpReporter(reporterEmail);
  const server = createObservabilityServer({
    loki: createLokiClient(config.infra.lokiUrl),
    tempo: createTempoClient(config.infra.tempoUrl),
    prometheus: createPrometheusClient(config.infra.prometheusUrl),
    serviceName: config.shopliteServiceName,
    lineCap: config.logLineCap,
    reporterEmail,
    reporterCustomerId: reporter?.customerId,
  });
  await server.connect(new StdioServerTransport());
  console.error(
    `mcp-observability ready for ${config.shopliteServiceName}` +
      (reporterEmail
        ? `, reporter ${reporterEmail}${reporter ? ` (customer ${reporter.customerId})` : ""}`
        : ", unscoped"),
  );
} catch (error) {
  console.error(`mcp-observability failed to start: ${messageOf(error)}`);
  process.exit(1);
}
