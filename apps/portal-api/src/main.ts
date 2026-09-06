import { createDb, getConfig } from "@incident-resolver/shared";
import { resolverFor } from "./resolver";
import { createScoreWriter } from "./scores";
import { createPortalApi } from "./server";

const config = getConfig();
const db = createDb(config.infra.databaseUrl);
// Run progress goes to stderr, the way the Resolver CLI reports it, so Fastify's own JSON
// log on stdout stays machine-readable.
const resolver = resolverFor(config, { log: (line) => console.error(line) });
// Every Decision and every Outcome goes back onto the run's Langfuse trace. The keys are
// secrets and come straight from the environment; without them nothing is scored.
const scores = createScoreWriter({
  publicKey: process.env.LANGFUSE_PUBLIC_KEY,
  secretKey: process.env.LANGFUSE_SECRET_KEY,
  baseUrl: config.infra.langfuseBaseUrl,
});
const app = createPortalApi({ db, config, resolver, scores, logger: true });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app.close().then(() => db.$client.end());
  });
}

await app.listen({ port: config.portal.port, host: config.portal.host });
