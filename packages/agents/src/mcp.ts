import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { Ticket } from "@incident-resolver/shared";
import { MultiServerMCPClient } from "@langchain/mcp-adapters";

/**
 * The MCP servers the Resolver's subagents use, spawned as stdio child processes the way
 * portal-api will spawn them: this repo's packages, run with tsx from their own directory.
 */
export const mcpServerNames = ["observability", "database", "incidents"] as const;
export type McpServerName = (typeof mcpServerNames)[number];

const packageNames: Record<McpServerName, string> = {
  observability: "@incident-resolver/mcp-observability",
  database: "@incident-resolver/mcp-database",
  incidents: "@incident-resolver/mcp-incidents",
};

export type StdioConnection = {
  transport: "stdio";
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stderr: "inherit";
};

const require = createRequire(import.meta.url);

/** The directory of an MCP server package, found through its workspace dependency. */
export function mcpPackageDir(name: McpServerName): string {
  return dirname(require.resolve(`${packageNames[name]}/package.json`));
}

type Env = Record<string, string | undefined>;

/**
 * One stdio connection per server. The database and observability servers are scoped to the
 * Reporter for customer Tickets through REPORTER_EMAIL — the first to reject unscoped queries,
 * the second to leave the Reporter's own email unmasked in log lines — and run unscoped for
 * tester and Sentinel Tickets even if the shell had a reporter set, so scoping is always the
 * Ticket's decision. The incidents server never needs the reporter.
 */
export function mcpConnections(
  ticket: Ticket,
  env: Env = process.env,
): Record<McpServerName, StdioConnection> {
  const base = withoutReporter(env);
  const scoped =
    ticket.source === "customer" && ticket.reporterEmail
      ? { ...base, REPORTER_EMAIL: ticket.reporterEmail }
      : base;
  return {
    observability: connection("observability", scoped),
    database: connection("database", scoped),
    incidents: connection("incidents", base),
  };
}

function connection(name: McpServerName, env: Record<string, string>): StdioConnection {
  return {
    transport: "stdio",
    command: process.execPath,
    args: ["--import", "tsx", "src/main.ts"],
    cwd: mcpPackageDir(name),
    env,
    stderr: "inherit",
  };
}

function withoutReporter(env: Env): Record<string, string> {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (key === "REPORTER_EMAIL" || key === "REPORTER_CUSTOMER_ID") continue;
    cleaned[key] = value;
  }
  return cleaned;
}

/** Opens the MCP client for a Ticket. Call `getTools()` to start the servers; `close()` when done. */
export function createMcpClient(ticket: Ticket, env: Env = process.env): MultiServerMCPClient {
  return new MultiServerMCPClient({
    mcpServers: mcpConnections(ticket, env),
    throwOnLoadError: true,
    prefixToolNameWithServerName: false,
    additionalToolNamePrefix: "",
    useStandardContentBlocks: true,
  });
}
