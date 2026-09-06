import { readFile } from "node:fs/promises";
import { formatIssues, type Ticket, ticketSchema } from "@incident-resolver/shared";

export const USAGE = "usage: pnpm resolve <ticket.json | -> [--thread <id>]";

export type CliArgs = {
  /** Path to the Ticket JSON, or `-` for stdin. */
  ticketPath: string;
  /** The LangGraph thread id; defaults to the Ticket id plus a timestamp so each run is fresh. */
  threadId?: string;
};

export function parseArgs(argv: string[]): CliArgs {
  const [ticketPath, ...rest] = argv;
  if (!ticketPath) throw new Error(USAGE);
  const args: CliArgs = { ticketPath };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag === "--thread") {
      const value = rest[i + 1];
      if (!value) throw new Error(`--thread needs an id\n${USAGE}`);
      args.threadId = value;
      i += 1;
    } else {
      throw new Error(`Unknown argument ${flag}\n${USAGE}`);
    }
  }
  return args;
}

/** Reads and validates a Ticket from a JSON file or stdin. */
export async function readTicket(path: string): Promise<Ticket> {
  const raw = path === "-" ? await readStdin() : await readFile(path, "utf8");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${error instanceof Error ? error.message : error}`);
  }
  const parsed = ticketSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`${path} is not a valid Ticket: ${formatIssues(parsed.error)}`);
  }
  return parsed.data;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
