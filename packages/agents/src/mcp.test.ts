import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Ticket } from "@incident-resolver/shared";
import { describe, expect, it } from "vitest";
import { mcpConnections, mcpPackageDir, mcpServerNames } from "./mcp";

const customer: Ticket = {
  id: "50000000-0000-4000-8000-000000000002",
  source: "customer",
  reporterEmail: "ava.chen@example.com",
  title: "Checkout failed",
  body: "Money not deducted.",
};

describe("mcpPackageDir", () => {
  it("resolves each MCP server package to a directory with its stdio entry point", () => {
    for (const name of mcpServerNames) {
      expect(existsSync(join(mcpPackageDir(name), "src", "main.ts"))).toBe(true);
    }
  });
});

describe("mcpConnections", () => {
  it("spawns both servers over stdio with tsx from their own package directory", () => {
    const connections = mcpConnections(customer, { PATH: "/usr/bin" });
    expect(Object.keys(connections).sort()).toEqual(["database", "incidents", "observability"]);
    for (const connection of Object.values(connections)) {
      expect(connection.transport).toBe("stdio");
      expect(connection.command).toBe(process.execPath);
      expect(connection.args).toEqual(["--import", "tsx", "src/main.ts"]);
      expect(existsSync(join(connection.cwd as string, "src", "main.ts"))).toBe(true);
      expect(connection.env?.PATH).toBe("/usr/bin");
    }
  });

  it("scopes the database and observability servers to the reporter for a customer Ticket", () => {
    const { database, observability, incidents } = mcpConnections(customer, {});
    expect(database.env?.REPORTER_EMAIL).toBe("ava.chen@example.com");
    expect(observability.env?.REPORTER_EMAIL).toBe("ava.chen@example.com");
    expect(incidents.env?.REPORTER_EMAIL).toBeUndefined();
  });

  it("runs them unscoped for tester and sentinel Tickets, even if the shell has a reporter set", () => {
    const tester: Ticket = { ...customer, source: "tester", reporterEmail: undefined };
    const { database, observability } = mcpConnections(tester, {
      REPORTER_EMAIL: "stale@example.com",
    });
    expect(database.env?.REPORTER_EMAIL).toBeUndefined();
    expect(observability.env?.REPORTER_EMAIL).toBeUndefined();
  });

  it("drops undefined environment values so the child gets only strings", () => {
    const { database } = mcpConnections(customer, { EMPTY: undefined, KEEP: "1" });
    expect(database.env).not.toHaveProperty("EMPTY");
    expect(database.env?.KEEP).toBe("1");
  });
});
