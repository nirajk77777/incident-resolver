import { z } from "zod";

/**
 * Time windows are written the way Prometheus and Loki write them: an integer and a unit,
 * such as `30s`, `15m`, `2h`, or `1d`. The string is passed straight into PromQL, and parsed
 * to milliseconds when a start time has to be computed for Loki.
 */
const pattern = /^(\d+)(ms|s|m|h|d)$/;
const unitMs: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseDuration(text: string): number {
  const match = pattern.exec(text);
  const unit = match?.[2] === undefined ? undefined : unitMs[match[2]];
  if (!match || unit === undefined) {
    throw new Error(
      `Not a duration: "${text}". Use an integer and a unit, such as 30s, 15m, 2h, or 1d`,
    );
  }
  return Number(match[1]) * unit;
}

export const durationSchema = z
  .string()
  .regex(pattern, "Use an integer and a unit, such as 30s, 15m, 2h, or 1d");

/** Loki and Tempo report time as a nanosecond epoch string; the agent reads ISO timestamps. */
export function isoFromNanos(nanos: string): string {
  return new Date(Number(BigInt(nanos) / 1_000_000n)).toISOString();
}
