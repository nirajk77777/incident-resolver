/** The message of anything thrown, for logging and tool results. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
