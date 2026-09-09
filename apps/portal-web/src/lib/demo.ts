import type { ResetReport } from "@incident-resolver/shared";

/**
 * The hidden Demo panel: the chord that reveals it, and how what the portal answered reads
 * on screen. Hidden because these two buttons are rehearsal props, not support desk work —
 * a Reviewer has no business resetting the system or making ShopLite fail — but reachable
 * without leaving the portal, since that is where the demo is being given from.
 */

/** Ctrl + Alt + D. Control and Option on a Mac, and bound by no browser on either. */
export const DEMO_SHORTCUT = "Ctrl + Alt + D";

type Chord = Pick<KeyboardEvent, "ctrlKey" | "altKey" | "metaKey" | "shiftKey" | "key" | "code">;

export function isDemoShortcut(event: Chord): boolean {
  return (
    event.ctrlKey &&
    event.altKey &&
    !event.metaKey &&
    !event.shiftKey &&
    // The physical key as well as the character: on a Mac, Option turns D into ∂ before the
    // page sees it, and `key` alone would never match there.
    (event.code === "KeyD" || event.key.toLowerCase() === "d")
  );
}

/**
 * What the panel says after a button. Deliberately not called an Outcome: that word is a
 * Ticket's, and means one of answered, data fixed, fix proposed or escalated (CONTEXT.md).
 */
export type PanelResult = { tone: "done" | "problem"; headline: string; lines: string[] };

/** What ShopLite answers a burst with, relayed by the portal. */
export type TrafficPlan = {
  customerId: string;
  durationMs: number;
  intervalMs: number;
  requests: number;
};

export function trafficStarted(plan: TrafficPlan): PanelResult {
  const seconds = Math.round(plan.durationMs / 1000);
  return {
    tone: "done",
    headline: `${plan.requests} empty-cart checkouts over ${seconds}s`,
    lines: [
      `One every ${plan.intervalMs}ms against ${plan.customerId.slice(0, 8)}…`,
      "Sentinel polls Prometheus every ten seconds and opens a Ticket by itself.",
    ],
  };
}

export function resetFinished(report: ResetReport): PanelResult {
  const failed = report.steps.filter((step) => !step.done);
  return {
    tone: report.ok ? "done" : "problem",
    headline: report.ok
      ? "Everything is back where a rehearsal starts"
      : `${failed.length} of ${report.steps.length} steps did not finish`,
    lines: report.steps.map(
      (step) => `${step.done ? "" : "could not "}${step.step.toLowerCase()}: ${step.detail}`,
    ),
  };
}

/** What went wrong reaching the portal at all, or what the portal refused. */
export function demoProblem(error: unknown): PanelResult {
  return {
    tone: "problem",
    headline: error instanceof Error ? error.message : String(error),
    lines: [],
  };
}
