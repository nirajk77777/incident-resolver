import { z } from "zod";

/**
 * Time windows are written the way Prometheus and Loki write them: an integer and a unit,
 * such as `30s`, `15m`, `2h`, or `1d`. The string is passed straight into PromQL range
 * selectors, and parsed to milliseconds when a start time has to be computed for Loki.
 */
const pattern = /^(\d+)(ms|s|m|h|d)$/;
const unitMs = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

export function parseDuration(text: string): number {
  const match = pattern.exec(text);
  if (!match) {
    throw new Error(
      `Not a duration: "${text}". Use an integer and a unit, such as 30s, 15m, 2h, or 1d`,
    );
  }
  const [, amount, unit] = match as unknown as [string, string, keyof typeof unitMs];
  return Number(amount) * unitMs[unit];
}

export const durationSchema = z
  .string()
  .regex(pattern, "Use an integer and a unit, such as 30s, 15m, 2h, or 1d");
