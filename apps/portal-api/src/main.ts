import { createDb, getConfig } from "@incident-resolver/shared";
import { resolverFor } from "./resolver";
import { createPortalApi } from "./server";

const config = getConfig();
const db = createDb(config.infra.databaseUrl);
// Run progress goes to stderr, the way the Resolver CLI reports it, so Fastify's own JSON
// log on stdout stays machine-readable.
const resolver = resolverFor(config, { log: (line) => console.error(line) });
const app = createPortalApi({ db, config, resolver, logger: true });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app.close().then(() => db.$client.end());
  });
}

await app.listen({ port: config.portal.port, host: config.portal.host });
