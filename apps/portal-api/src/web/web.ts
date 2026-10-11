import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

export type PortalWebOptions = {
  /** Absolute path of the built portal — what `pnpm --filter @incident-resolver/portal-web build` writes. */
  webDistDir: string;
  /** Where the API is mounted, so a miss under it stays JSON instead of becoming a page. */
  apiPrefix: string;
};

/**
 * Serves the built portal from the same origin as the API, which is what the deployed
 * container is: one process behind one domain. It takes over what the Vite dev server does
 * on a laptop — hand back `index.html` for a client-side route such as `/tickets/:id` —
 * so the portal's relative `/api` calls work unchanged in both places and it needs no CORS.
 */
export function servePortalWeb(
  app: FastifyInstance,
  { webDistDir, apiPrefix }: PortalWebOptions,
): void {
  // `wildcard: false` registers a route per built file rather than one catch-all, which
  // leaves every other URL to the not-found handler below — that is the SPA fallback.
  app.register(fastifyStatic, { root: webDistDir, wildcard: false });

  app.setNotFoundHandler((request, reply) => {
    if (isApiCall(request.url, apiPrefix) || request.method !== "GET") {
      return reply.code(404).send({ error: "Not Found" });
    }
    return reply.sendFile("index.html");
  });
}

/**
 * Whether a URL was meant for the API rather than for the portal's router. A miss there is a
 * real 404 — answering it with `index.html` would hand a page to a `fetch` that asked for
 * JSON, and the caller would report a parse error instead of the 404 it got.
 */
function isApiCall(url: string, apiPrefix: string): boolean {
  return apiPrefix !== "" && (url === apiPrefix || url.startsWith(`${apiPrefix}/`));
}
