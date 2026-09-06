import type { Config } from "@incident-resolver/shared";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

/**
 * LangGraph checkpoints live in the portal schema, one thread per Resolver run, so a run can
 * be resumed after an approval interrupt. `setup()` creates the tables on first use. Call
 * `end()` when done: it owns a connection pool.
 */
export async function createCheckpointer(config: Config): Promise<PostgresSaver> {
  const checkpointer = PostgresSaver.fromConnString(config.infra.databaseUrl, {
    schema: "portal",
  });
  await checkpointer.setup();
  return checkpointer;
}
