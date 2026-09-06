import type { ZodError } from "zod";

/** Zod issues as one line: `path: message; path: message`. A top-level issue is named `value`. */
export function formatIssues(error: ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "value"}: ${issue.message}`)
    .join("; ");
}

/** The message of anything thrown, for logging and tool results. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
