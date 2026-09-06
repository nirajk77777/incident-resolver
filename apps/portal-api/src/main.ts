import { createDb, getConfig } from "@incident-resolver/shared";
import { resolverFor } from "./resolver";
import { createPortalApi } from "./server";

const config = getConfig();
const db = createDb(config.infra.databaseUrl);
const app = createPortalApi({ db, config, resolver: resolverFor(config), logger: true });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app.close().then(() => db.$client.end());
  });
}

await app.listen({ port: config.portal.port, host: config.portal.host });
