import { createDemo } from "@incident-resolver/portal-api";
import { createDb, getConfig } from "@incident-resolver/shared";

/**
 * `pnpm demo:reset`. Puts the whole system back to where a rehearsal starts: ShopLite
 * reseeded, the portal's Tickets, timelines, approvals and run checkpoints cleared, and every
 * per-Ticket Workspace removed. Incidents are kept — they are the knowledge base, and a
 * rehearsal without them would be rehearsing a different system.
 *
 * It is the same `createDemo` the portal's hidden Demo panel calls, so the button and the
 * command cannot drift apart. Stop the portal first, or use the panel: a reset while a run is
 * in flight leaves that run writing to a Ticket that is no longer there, which is why the
 * portal's own route refuses one while anything is still running.
 */
const config = getConfig();
const db = createDb(config.infra.databaseUrl);

try {
  const report = await createDemo({ db, config }).reset();
  for (const step of report.steps) {
    console.log(`${step.done ? "ok  " : "FAIL"}  ${step.step}: ${step.detail}`);
  }
  if (!report.ok) {
    console.error("\nThe reset did not finish. Fix what is named above and run it again.");
    process.exitCode = 1;
  }
} finally {
  await db.$client.end();
}
