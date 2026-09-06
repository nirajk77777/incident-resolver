/**
 * What Sentinel has just reported. A detection is made over a window, and the requests
 * behind it stay inside that window until it has rolled past — so a poll ten seconds later
 * sees the same failures and would file a second Ticket about them. Sentinel holds each
 * fingerprint for the length of its own window after reporting it.
 *
 * This is not the deduplication rule: that one is the portal's, and it is what keeps at most
 * one open Ticket per fingerprint however many watchers there are. This is Sentinel not
 * reporting the same requests twice, which matters most exactly where the portal's rule
 * cannot help — when the Ticket it just opened has already been closed.
 */
export type ReportLedger = {
  /** Whether this fingerprint was reported recently enough that its window still holds. */
  held(fingerprint: string): boolean;
  /** Records that a Ticket was opened for it. */
  hold(fingerprint: string): void;
};

export function createReportLedger(holdMs: number, now = () => Date.now()): ReportLedger {
  const reportedAt = new Map<string, number>();
  return {
    held(fingerprint) {
      const at = reportedAt.get(fingerprint);
      if (at === undefined) return false;
      if (now() - at < holdMs) return true;
      // Expired, and dropped rather than left: a long-lived watcher would otherwise
      // accumulate a row per route it has ever seen fail.
      reportedAt.delete(fingerprint);
      return false;
    },
    hold(fingerprint) {
      reportedAt.set(fingerprint, now());
    },
  };
}

/** A ledger that holds nothing, for a caller that wants every detection reported. */
export const reportsEverything: ReportLedger = { held: () => false, hold: () => {} };
