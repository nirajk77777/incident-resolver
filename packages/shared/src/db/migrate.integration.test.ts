import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../config";
import { createDb } from "./client";
import { runMigrations } from "./migrate";

// Needs `docker compose up`. Run with `pnpm test:integration`.
describe("database migrations", () => {
  const db = createDb(loadConfig().infra.databaseUrl);

  beforeAll(async () => {
    await runMigrations(db);
  });

  afterAll(async () => {
    await db.$client.end();
  });

  it("creates the shoplite, portal, and knowledge schemas", async () => {
    const { rows } = await db.$client.query<{ schema_name: string }>(
      `SELECT schema_name FROM information_schema.schemata
       WHERE schema_name IN ('shoplite', 'portal', 'knowledge')
       ORDER BY schema_name`,
    );
    expect(rows.map((r) => r.schema_name)).toEqual(["knowledge", "portal", "shoplite"]);
  });

  it("installs the pgvector extension", async () => {
    const { rows } = await db.$client.query<{ extname: string }>(
      "SELECT extname FROM pg_extension WHERE extname = 'vector'",
    );
    expect(rows).toHaveLength(1);
  });

  it("can build a 1536-dimension vector, the size Cohere embed-v4.0 returns", async () => {
    const zeros = `[${new Array(1536).fill(0).join(",")}]`;
    const { rows } = await db.$client.query<{ dims: number }>(
      "SELECT vector_dims($1::vector(1536)) AS dims",
      [zeros],
    );
    expect(rows[0]?.dims).toBe(1536);
  });

  it("is idempotent: running again applies nothing and fails nothing", async () => {
    await expect(runMigrations(db)).resolves.toBeUndefined();
  });
});
