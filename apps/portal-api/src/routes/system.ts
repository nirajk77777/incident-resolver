import type { FastifyInstance } from "fastify";

export async function systemRoutes(
  app: FastifyInstance,
  {
    resolverName,
    grafanaUrl,
    langfuseBaseUrl,
  }: { resolverName: string; grafanaUrl: string; langfuseBaseUrl: string },
): Promise<void> {
  app.get("/health", async () => ({ status: "ok", resolver: resolverName }));

  /**
   * What portal-web needs from the portal's own configuration: the two observability tools
   * a Ticket links out to. Serving them keeps the web app free of a build-time environment.
   */
  app.get("/config", async () => ({ resolver: resolverName, grafanaUrl, langfuseBaseUrl }));
}
