import { type WorkspaceStore, workspaceStoreFor } from "@incident-resolver/agents";
import { type Config, type Db, incidents, messageOf, tickets } from "@incident-resolver/shared";
import { count, sql } from "drizzle-orm";

/**
 * The rehearsal props behind the portal's hidden Demo panel: put everything back, and make
 * ShopLite fail on purpose. Both live here so the panel's buttons and `pnpm demo:reset` do
 * exactly the same thing, rather than the script and the portal drifting apart.
 *
 * What a reset keeps is the point of it. Incidents are the knowledge base — twenty seeded
 * ones plus whatever the agent has learned — and a rehearsal that wiped them would be
 * rehearsing a different system. Everything a run produced goes.
 */

/** One thing a reset did, or could not do. A reset reports rather than throws. */
export type ResetStep = { step: string; done: boolean; detail: string };

export type ResetReport = {
  steps: ResetStep[];
  /** False when any step failed, which the panel shows and the script exits non-zero on. */
  ok: boolean;
};

/** The LangGraph checkpointer's tables in the `portal` schema, one row per run thread. */
const checkpointTables = ["checkpoint_writes", "checkpoint_blobs", "checkpoints"] as const;

export type DemoOptions = {
  db: Db;
  config: Config;
  /** Injected in tests; by default the same store `pnpm workspaces:clean` uses. */
  workspaces?: WorkspaceStore;
  /** Cancels a burst and reseeds ShopLite. By default a call to ShopLite's own demo route. */
  resetShoplite?: () => Promise<void>;
};

export type Demo = {
  reset(): Promise<ResetReport>;
  /** Forwards a burst to ShopLite and answers with what it said. */
  simulateTraffic(body: unknown): Promise<{ status: number; body: unknown }>;
};

export function createDemo({ db, config, workspaces, resetShoplite }: DemoOptions): Demo {
  const store = workspaces ?? workspaceStoreFor(config);
  const reseed =
    resetShoplite ??
    (async () => {
      const { status, body } = await postToShoplite(config, "/demo/reset", undefined);
      if (status !== 200) throw new Error(`ShopLite answered ${status}: ${describe(body)}`);
    });

  return {
    async reset() {
      const steps: ResetStep[] = [];
      const attempt = async (step: string, run: () => Promise<string>) => {
        try {
          steps.push({ step, done: true, detail: await run() });
        } catch (error) {
          steps.push({ step, done: false, detail: messageOf(error) });
        }
      };

      await attempt("ShopLite data", async () => {
        await reseed();
        return `reseeded through ${config.shopliteApiUrl}`;
      });

      // Timeline entries and approvals are the Ticket's, and go with it: both tables are
      // `on delete cascade` from `portal.tickets`, so this one delete is the whole clear.
      await attempt("Tickets, their timelines and approvals", async () => {
        const removed = await db.delete(tickets).returning({ id: tickets.id });
        return `${removed.length} Tickets removed`;
      });

      await attempt("Run checkpoints", async () => {
        const cleared: string[] = [];
        for (const table of checkpointTables) {
          const exists = await db.execute(
            sql`select to_regclass(${`portal.${table}`}) is not null as present`,
          );
          if (!(exists.rows[0] as { present?: boolean } | undefined)?.present) continue;
          await db.execute(sql.raw(`truncate table portal.${table}`));
          cleared.push(table);
        }
        return cleared.length === 0 ? "no checkpoint tables yet" : `cleared ${cleared.join(", ")}`;
      });

      // A Workspace left behind would let a re-run of a Ticket read the last run's patch.
      await attempt("Workspaces", async () => {
        await store.removeAll();
        return "every per-Ticket ShopLite clone removed";
      });

      await attempt("Incidents", async () => {
        const [row] = await db.select({ kept: count() }).from(incidents);
        return `${row?.kept ?? 0} kept: the knowledge base is not part of a reset`;
      });

      return { steps, ok: steps.every((step) => step.done) };
    },

    simulateTraffic(body) {
      return postToShoplite(config, "/demo/simulate-traffic", body);
    },
  };
}

/**
 * Calls one of ShopLite's demo routes and passes its answer straight back, status and all.
 * The portal is a relay here and nothing more, so the panel stays same-origin and portal-web
 * never has to know where ShopLite is — and a refusal ShopLite has already worded, such as a
 * burst already running, reaches the panel as ShopLite worded it.
 */
async function postToShoplite(
  config: Config,
  path: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(new URL(path, config.shopliteApiUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

/** What ShopLite said went wrong, for a reset step's detail line. */
function describe(body: unknown): string {
  const said = (body as { error?: unknown } | null)?.error;
  return typeof said === "string" ? said : "no reason given";
}
