import type { FastifyInstance } from "fastify";
import type { PortalServices } from "../server";

export async function systemRoutes(
  app: FastifyInstance,
  { config, resolver }: PortalServices,
): Promise<void> {
  app.get("/health", async () => ({ status: "ok", resolver: resolver.name }));

  /**
   * What portal-web needs from the portal's own configuration: the two observability tools
   * a Ticket links out to. Serving them keeps the web app free of a build-time environment.
   */
  app.get("/config", async () => ({
    resolver: resolver.name,
    grafanaUrl: config.infra.grafanaUrl,
    langfuseBaseUrl: config.infra.langfuseBaseUrl,
  }));
}
