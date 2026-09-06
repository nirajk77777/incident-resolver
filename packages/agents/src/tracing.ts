import type { Config, IncidentCategory, Ticket } from "@incident-resolver/shared";
import type { Callbacks } from "@langchain/core/callbacks/manager";
import { CallbackHandler } from "@langfuse/langchain";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
  LangfuseOtelSpanAttributes,
  propagateAttributes,
  startActiveObservation,
} from "@langfuse/tracing";
import { NodeSDK } from "@opentelemetry/sdk-node";
import type { LangfuseCredentials } from "./langfuse-prompts";
import { type Prompts, promptVersions } from "./prompts";
import type { RunReport } from "./resolver";

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

/** The same keys prompt management uses: read from the environment, both needed to trace. */
export function startTracing({ publicKey, secretKey, baseUrl }: LangfuseCredentials): Tracing {
  if (!publicKey || !secretKey) {
    return { enabled: false, shutdown: async () => {} };
  }
  const sdk = new NodeSDK({
    spanProcessors: [new LangfuseSpanProcessor({ publicKey, secretKey, baseUrl })],
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

export type TraceRunOptions = {
  ticket: Ticket;
  models: ModelNames;
  /** Recorded on the trace so a run can be read against the prompt version that produced it. */
  prompts: Prompts;
};

/**
 * Runs one Resolver invocation as a Langfuse trace: session id equals the Ticket id, the
 * LangChain callback handler nests every subagent, tool, and model span under the run, and
 * the root span carries the tags. Source, models, and the prompt versions are known up front;
 * the Category is written onto the root span once the Verdict is in, since trace tags are read
 * from any span.
 */
export function traceRun(
  { ticket, models, prompts }: TraceRunOptions,
  run: (callbacks: Callbacks) => Promise<RunReport>,
): Promise<RunReport> {
  const sessionId = ticket.id;
  const tags = traceTags(ticket, models);
  // Flat: Langfuse trace metadata is string-valued, so each prompt gets its own key.
  //
  // Metadata rather than the SDK's own prompt-to-generation link: that link is registered by
  // putting a prompt object in the invoke's `langfusePrompt` metadata, and LangChain metadata
  // is inherited by every child run, so the Resolver's prompt would be stamped on Triage's and
  // each Investigator's generations too. Five prompts run under one trace here, and a wrong
  // attribution is worse than a trace-level record of all five.
  const metadata: Record<string, string> = {
    ticketId: ticket.id,
    source: ticket.source,
    promptLabel: prompts.label,
    ...Object.fromEntries(
      Object.entries(promptVersions(prompts)).map(([name, version]) => [`prompt.${name}`, version]),
    ),
  };

  return propagateAttributes({ sessionId, tags, metadata, traceName: "resolve-ticket" }, () =>
    startActiveObservation(
      "resolve-ticket",
      async (span) => {
        span.update({ input: ticket });
        const handler = new CallbackHandler({ sessionId, tags, traceMetadata: metadata });
        const report = await run([handler]);
        span.update({ output: report.verdict });
        span.otelSpan.setAttribute(
          LangfuseOtelSpanAttributes.TRACE_TAGS,
          traceTags(ticket, models, report.verdict.category),
        );
        return report;
      },
      { asType: "agent" },
    ),
  );
}
