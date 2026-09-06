import {
  createPromptClient,
  langfusePromptFetcher,
  loadPrompt,
  resolvePrompts,
} from "@incident-resolver/agents";
import { createLokiClient, createPrometheusClient } from "@incident-resolver/mcp-observability";
import { getConfig, messageOf } from "@incident-resolver/shared";
import { runSentinelPass, type SentinelDeps } from "./graph";
import { createModelComposer } from "./model";
import { createPortalClient } from "./portal";
import { createReportLedger } from "./recent";
import { createTicketWriter } from "./ticket-text";

/**
 * The Sentinel worker. It polls Prometheus every `SENTINEL_POLL_INTERVAL_MS`, and each poll
 * is one pass of the graph in `graph.ts`. Passes never overlap: the wait starts when the last
 * one finished, so a slow Loki delays the next poll rather than stacking passes on top of it.
 */

const config = getConfig();
const log = (line: string) => console.error(`[sentinel] ${line}`);

// The prompt is only used when there is a model to give it to. Langfuse is optional here as
// it is everywhere else: without the keys the prompt comes from the repository file.
const apiKey = process.env.OPENAI_API_KEY;
const promptClient = createPromptClient({
  publicKey: process.env.LANGFUSE_PUBLIC_KEY,
  secretKey: process.env.LANGFUSE_SECRET_KEY,
  baseUrl: config.infra.langfuseBaseUrl,
});
const prompts = await resolvePrompts({
  label: config.infra.langfusePromptLabel,
  names: ["sentinel"],
  fetch: promptClient ? langfusePromptFetcher(promptClient) : undefined,
  onFallback: (name, reason) => log(`Prompt ${name} came from its file: ${reason}`),
});
const systemPrompt = apiKey ? prompts.text("sentinel") : loadPrompt("sentinel");

const deps: SentinelDeps = {
  prometheus: createPrometheusClient(config.infra.prometheusUrl),
  loki: createLokiClient(config.infra.lokiUrl),
  portal: createPortalClient(config.portal.url),
  writeTicket: createTicketWriter({
    compose: apiKey
      ? createModelComposer({ model: config.models.sentinel, apiKey, systemPrompt })
      : undefined,
    onFallback: (reason) => log(`Wording the Ticket plainly: ${reason}`),
  }),
  thresholds: config.sentinel,
  serviceName: config.shopliteServiceName,
  // A detection covers the window it was measured over, and those requests stay inside it
  // for that long, so one spike is one Ticket however often the worker polls.
  reported: createReportLedger(config.sentinel.windowSeconds * 1000),
};

const { errorRatio, windowSeconds, minRequests, pollIntervalMs } = config.sentinel;
log(
  `Watching ${config.shopliteServiceName} on ${config.infra.prometheusUrl} every ${pollIntervalMs}ms. ` +
    `A route fires above ${Math.round(errorRatio * 100)}% server errors over ${windowSeconds}s ` +
    `with at least ${minRequests} requests. Tickets go to ${config.portal.url}` +
    (apiKey ? ` and are worded by ${config.models.sentinel}.` : ", worded without a model."),
);

let running = true;
/** Wakes the wait between passes early, so Ctrl-C does not sit through the poll interval. */
const stopping: Array<() => void> = [];
const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    stopping.push(() => {
      clearTimeout(timer);
      resolve();
    });
  });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    log(`${signal}: stopping after this pass`);
    running = false;
    for (const wake of stopping.splice(0)) wake();
  });
}

while (running) {
  try {
    const pass = await runSentinelPass(deps);
    for (const warning of pass.warnings) log(warning);
    if (pass.anomaly && pass.opened) {
      const { route, serverErrorRate, serverErrors, requests, window } = pass.anomaly;
      log(
        `${route}: ${Math.round(serverErrorRate * 100)}% of ${requests} requests failed over ${window} ` +
          `(${serverErrors} server errors). ` +
          (pass.opened.created
            ? `Opened Ticket ${pass.opened.id}.`
            : `Ticket ${pass.opened.id} is already open on this fingerprint.`),
      );
    }
  } catch (error) {
    // A pass that failed is a pass, not the end of the worker: Prometheus may be restarting,
    // the portal may not be up yet, and the next poll is ten seconds away.
    log(`Pass failed: ${messageOf(error)}`);
  }
  if (running) await sleep(pollIntervalMs);
}

log("Stopped");
