import type { WriteEffects } from "@incident-resolver/agents";
import type {
  ApprovalAction,
  Config,
  Decision,
  Proposal,
  Ticket,
  Verdict,
} from "@incident-resolver/shared";
import { createAgentResolver, type NodeEnv } from "./agent-resolver";
import { createFakeResolver } from "./fake-resolver";

/**
 * What a Resolver run tells the portal as it goes. Everything but the Verdict becomes a
 * timeline entry; the Verdict closes the Ticket. `decision` is missing on purpose: a
 * Reviewer's Decision is the portal's own event, written when the approval gate resumes
 * the run, never something the Resolver reports.
 */
export type ResolverEvent =
  | { type: "subagent_start"; name: string }
  | { type: "subagent_end"; name: string; summary?: string }
  | { type: "tool_call"; name: string; args: unknown }
  /** `failed` when the tool did not answer the call: a guard refused it, or it broke. */
  | { type: "tool_result"; name: string; result: unknown; failed?: boolean }
  | { type: "message"; text: string }
  /**
   * A write the run cannot make on its own. The stream ends here and the run waits on the
   * thread until a Decision resumes it; `args` is the interrupted tool call's arguments,
   * which the portal reads the Proposal out of.
   */
  | { type: "interrupt"; action: ApprovalAction; args: Record<string, unknown> }
  /**
   * The Langfuse trace this run is writing to. Not a timeline entry: it goes on the Ticket,
   * so the portal can link to the trace of whichever run is the latest.
   */
  | { type: "trace"; langfuseTraceId: string }
  | { type: "verdict"; verdict: Verdict };

/** Everything the Resolver reports that the timeline records without adding to it. */
export type TimelineResolverEvent = Exclude<ResolverEvent, { type: "trace" | "interrupt" }>;

export type ResolverRun = {
  ticket: Ticket;
  /** Counts re-runs of the same Ticket from 1; stamped on every timeline entry. */
  run: number;
  /** What the portal does when one of this run's writes is approved. */
  effects: WriteEffects;
  signal?: AbortSignal;
};

/** The Reviewer's answer, as the run that is waiting on it needs to hear it. */
export type ResolverDecision = {
  action: ApprovalAction;
  decision: Decision;
  /** The Proposal as the Reviewer edited it, when the Decision was `edit`. */
  proposal?: Proposal | undefined;
  /** Why, when the Decision was `reject`. The agent reads this and decides what to do instead. */
  reason?: string | undefined;
};

/**
 * The seam between the portal and whatever investigates a Ticket. The portal reads the
 * stream, writes the timeline, and moves the lifecycle; it knows nothing else about the run.
 *
 * A stream ends in one of three ways. A Verdict closes the Ticket. An interrupt leaves it
 * waiting on a Reviewer, and `resume` is what carries it on. Anything else left the Ticket
 * unresolved, and the portal treats that as a failed run.
 */
export type TicketResolver = {
  name: string;
  resolve(run: ResolverRun): AsyncIterable<ResolverEvent>;
  /** Carries a run that stopped at the gate on, with what the Reviewer decided. */
  resume(run: ResolverRun, decision: ResolverDecision): AsyncIterable<ResolverEvent>;
  /** Releases whatever the Resolver holds open between runs. Called when the portal closes. */
  close?(): Promise<void>;
};

/**
 * Which Resolver the portal runs Tickets through, from `RESOLVER` in the environment: the
 * agent from `@incident-resolver/agents`, or the scripted stand-in that needs no model.
 * Both reach the portal through the seam above, so nothing downstream can tell them apart.
 */
export type ResolverForOptions = {
  /** Passed to the MCP servers the real Resolver spawns, and read for the API keys. */
  env?: NodeEnv;
  /** Where the real Resolver reports what a run did, for whoever runs the portal. */
  log?: (line: string) => void;
};

export function resolverFor(
  config: Config,
  { env = process.env, log }: ResolverForOptions = {},
): TicketResolver {
  if (config.portal.resolver === "fake") {
    return createFakeResolver({ stepDelayMs: config.portal.fakeResolverStepDelayMs });
  }
  const openAiApiKey = env.OPENAI_API_KEY;
  if (!openAiApiKey) {
    throw new Error(
      "OPENAI_API_KEY is not set; the Resolver calls OpenAI models. Set RESOLVER=fake to run the scripted one",
    );
  }
  return createAgentResolver({
    config,
    openAiApiKey,
    langfuse: {
      publicKey: env.LANGFUSE_PUBLIC_KEY,
      secretKey: env.LANGFUSE_SECRET_KEY,
      baseUrl: config.infra.langfuseBaseUrl,
    },
    env,
    log,
  });
}
