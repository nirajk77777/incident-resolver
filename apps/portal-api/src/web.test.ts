import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { servePortalWeb } from "./web";

const INDEX_HTML = "<!doctype html><title>Portal</title>";
const ASSET_JS = "console.log('portal')";

describe("serving the portal from the API process", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const webDistDir = await mkdtemp(join(tmpdir(), "portal-dist-"));
    await writeFile(join(webDistDir, "index.html"), INDEX_HTML);
    await mkdir(join(webDistDir, "assets"));
    await writeFile(join(webDistDir, "assets", "app.js"), ASSET_JS);

    app = Fastify();
    // Stands in for the real routes, mounted the way createPortalApi mounts them.
    app.register(
      async (api) => {
        api.get("/tickets", async () => ({ tickets: [] }));
      },
      { prefix: "/api" },
    );
    servePortalWeb(app, { webDistDir, apiPrefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("serves a built asset as itself", async () => {
    const response = await app.inject({ method: "GET", url: "/assets/app.js" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(ASSET_JS);
  });

  it("answers the portal's own routes with index.html, even where the API has the same path", async () => {
    for (const url of [
      "/",
      "/tickets",
      "/tickets/new",
      "/tickets/0f4a3c1e-0000-4000-8000-000000000001",
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(200);
      expect(response.body, url).toBe(INDEX_HTML);
    }
  });

  it("still reaches the API under its prefix", async () => {
    const response = await app.inject({ method: "GET", url: "/api/tickets" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ tickets: [] });
  });

  it("keeps a miss under the API prefix a JSON 404 rather than a page", async () => {
    const response = await app.inject({ method: "GET", url: "/api/no-such-route" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Not Found" });
  });

  it("does not answer a non-GET miss with a page", async () => {
    const response = await app.inject({ method: "POST", url: "/tickets" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Not Found" });
  });
});
