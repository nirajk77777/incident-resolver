import { messageOf } from "@incident-resolver/shared";
import { toolErrorMiddleware } from "langchain";

/**
 * A failing tool must not end the run. An Investigator that writes SQL against a column that
 * does not exist, or asks Loki for a window it cannot parse, should read the error and try
 * again; and if one Investigator cannot be salvaged, the Resolver should still decide from the
 * other two rather than the whole Ticket dying with it. Without this a thrown tool error
 * propagates out of the subagent and out of `resolveTicket`.
 *
 * The message is passed through rather than summarised: every tool here is one of this repo's
 * MCP servers, which redact their results and their failures before returning them, and the
 * text is the only thing that tells the model what to correct.
 */
export function toolErrorReply(error: unknown, toolName: string): string | undefined {
  if (isAbort(error)) return undefined;
  return (
    `Tool ${toolName} failed: ${messageOf(error)}. ` +
    "Read the message, correct the call, and try once more. If it cannot be corrected, " +
    "report what you could not find out as Evidence rather than guessing at it."
  );
}

/** Turns a failing tool into an error the model can act on, for the Resolver and every subagent. */
export function createToolErrorGuard() {
  return toolErrorMiddleware({
    onError: (error, request) => toolErrorReply(error, request.toolCall.name),
  });
}

/** The run's deadline or a cancelled run: nothing to correct, so it stays an error. */
function isAbort(error: unknown): boolean {
  const name = error instanceof Error ? error.name : undefined;
  return name === "AbortError" || name === "TimeoutError";
}
