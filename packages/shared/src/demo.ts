/**
 * What a demo reset did. The portal runs one, `pnpm demo:reset` runs the same one, and the
 * portal's hidden Demo panel shows the answer, so the shape all three agree on lives here
 * rather than being copied into the browser.
 */

/** One thing a reset did, or could not do. A reset reports rather than throwing. */
export type ResetStep = { step: string; done: boolean; detail: string };

export type ResetReport = {
  steps: ResetStep[];
  /** False when any step failed, which the panel shows and the script exits non-zero on. */
  ok: boolean;
};
