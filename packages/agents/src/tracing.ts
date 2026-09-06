import type { Config, IncidentCategory, Ticket } from "@incident-resolver/shared";
import type { Callbacks } from "@langchain/core/callbacks/manager";
import { CallbackHandler } from "@langfuse/langchain";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { propagateAttributes, startActiveObservation, startObservation } from "@langfuse/tracing";
import { NodeSDK } from "@opentelemetry/sdk-node";
import type { RunResult } from "./resolver";

/**
 * Langfuse v5 rides on OpenTelemetry: a LangfuseSpanProcessor in the Node SDK exports every
 * span the LangChain CallbackHandler creates, so each Resolver run is one trace with nested
 * spans per subagent, tool call, and model call. Without keys the run is simply untraced.
 */
export type Tracing = {
  enabled: boolean;
  /** Flushes pending spans. Call before the process exits. */
  shutdown(): Promise<void>;
};

type Env = Record<string, string | undefined>;

export function startTracing(env: Env = process.env): Tracing {
  const publicKey = env.LANGFUSE_PUBLIC_KEY;
  const secretKey = env.LANGFUSE_SECRET_KEY;
  if (!publicKey || !secretKey) {
    return { enabled: false, shutdown: async () => {} };
  }
  const sdk = new NodeSDK({
    spanProcessors: [
      new LangfuseSpanProcessor({ publicKey, secretKey, baseUrl: env.LANGFUSE_BASE_URL }),
    ],
  });
  sdk.start();
  return { enabled: true, shutdown: () => sdk.shutdown() };
}

type ModelNames = Pick<Config["models"], "resolver" | "triage" | "investigator">;

/** Trace tags: the Ticket's Source, the model names, and the Category once Triage has decided it. */
export function traceTags(
  ticket: Ticket,
  models: ModelNames,
  category?: IncidentCategory,
): string[] {
  const modelTags = [...new Set([models.resolver, models.triage, models.investigator])].map(
    (model) => `model:${model}`,
  );
  return [`source:${ticket.source}`, ...modelTags, ...(category ? [`category:${category}`] : [])];
}

/**
 * Runs one Resolver invocation as a Langfuse trace: session id equals the Ticket id, tags carry
 * the Source and models from the start and the Category once the Verdict is in, and the
 * LangChain callback handler nests every subagent, tool, and model span under the run.
 */
export function traceRun(
  ticket: Ticket,
  models: ModelNames,
  run: (callbacks: Callbacks) => Promise<RunResult>,
): Promise<RunResult> {
  const sessionId = ticket.id;
  const tags = traceTags(ticket, models);
  const metadata = { ticketId: ticket.id, source: ticket.source };

  return propagateAttributes({ sessionId, tags, metadata, traceName: "resolve-ticket" }, () =>
    startActiveObservation(
      "resolve-ticket",
      async (span) => {
        span.update({ input: ticket });
        const handler = new CallbackHandler({ sessionId, tags, traceMetadata: metadata });
        const result = await run([handler]);
        span.update({ output: result.verdict });
        // The Category is only known now; a child span carrying the full tag list sets it on the trace.
        propagateAttributes(
          { sessionId, tags: traceTags(ticket, models, result.verdict.category), metadata },
          () => {
            startObservation("verdict", { output: result.verdict }, { asType: "event" }).end();
          },
        );
        return result;
      },
      { asType: "agent" },
    ),
  );
}
