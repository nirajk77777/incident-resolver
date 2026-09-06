import { readFile } from "node:fs/promises";
import { getConfig, messageOf, newTicketSchema } from "@incident-resolver/shared";
import {
  type ClosedTicket,
  type Mark,
  mark,
  type PlantedBug,
  plantedBugs,
  renderScorecard,
} from "./scorecard-plan";

/**
 * `pnpm scorecard`. Files every planted bug as a Ticket, approves whatever the run stops on,
 * and reports the Category and the Outcome of each against what that bug should produce.
 * It is the answer to "does the agent still solve all of them", asked in one command instead
 * of by walking the demo.
 *
 * It drives the portal over HTTP exactly as a Reviewer would, so what it measures is the
 * system a demo runs, not a harness beside it. That means it needs a portal on
 * `PORTAL_API_URL` with `RESOLVER=real`, ShopLite migrated, seeded and running, the compose
 * stack up, `pnpm seed:incidents` done, and `OPENAI_API_KEY` and `COHERE_API_KEY` set. Under
 * the fake Resolver every row fails, which is the honest answer: the fake solves nothing.
 *
 *   pnpm scorecard                      every planted bug
 *   pnpm scorecard stale-cart-total     one of them, by key
 *
 * Every Proposal is approved as the agent wrote it. A scorecard that edited or rejected would
 * be measuring the Reviewer, and the gate itself is covered by the portal's own tests.
 */

const config = getConfig();
const portal = config.portal.url;
/** How long one Ticket may take before the scorecard gives up on it and marks it unfinished. */
const ticketTimeoutMs = config.runTimeoutMs;
/** How often the portal is asked whether a Ticket has closed or stopped for a Decision. */
const pollIntervalMs = 1_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function portalJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(new URL(path, portal), init);
  const body = (await response.json().catch(() => null)) as (T & { message?: string }) | null;
  if (!response.ok) {
    throw new Error(`${init?.method ?? "GET"} ${path}: ${response.status} ${body?.message ?? ""}`);
  }
  if (body === null) throw new Error(`${path} answered with no body`);
  return body;
}

type TicketState = ClosedTicket & { status: string };
type ApprovalState = { id: string; action: string; decision: string | null };

/** Files one planted bug's Ticket, worded the way its Reporter worded it. */
async function file(bug: PlantedBug): Promise<string> {
  const written = JSON.parse(await readFile(bug.ticket, "utf8")) as Record<string, unknown>;
  // The id in the file names the demo Ticket for the CLI; the portal gives its own.
  const { id: _named, ...ticket } = written;
  const parsed = newTicketSchema.parse(ticket);
  const opened = await portalJson<{ id: string }>("/tickets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(parsed),
  });
  return opened.id;
}

/**
 * Approves the one Proposal this Ticket is waiting on. Only one: the decision endpoint acts
 * on whichever Proposal the Ticket is paused at, and a second call while it carries that one
 * out is a 409. If the run stops again, the next poll finds it.
 */
async function approvePending(ticketId: string): Promise<void> {
  const { approvals } = await portalJson<{ approvals: ApprovalState[] }>(
    `/tickets/${ticketId}/approvals`,
  );
  const waiting = approvals.find((approval) => approval.decision === null);
  if (!waiting) return;
  await portalJson(`/tickets/${ticketId}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision: "approve" }),
  });
  console.log(`      approved ${waiting.action}`);
}

/**
 * Waits for one Ticket to close, approving anything it stops on along the way. A Ticket that
 * runs past the timeout comes back as it stands, which marks as a failure with the status it
 * was stuck in rather than hanging the scorecard.
 */
async function runToClose(ticketId: string): Promise<TicketState> {
  const deadline = Date.now() + ticketTimeoutMs;
  let ticket = await portalJson<TicketState>(`/tickets/${ticketId}`);
  while (ticket.status !== "closed" && Date.now() < deadline) {
    if (ticket.status === "awaiting_approval") await approvePending(ticketId);
    await sleep(pollIntervalMs);
    ticket = await portalJson<TicketState>(`/tickets/${ticketId}`);
  }
  return ticket;
}

const only = process.argv.slice(2).filter((argument) => !argument.startsWith("-"));
const chosen =
  only.length === 0 ? plantedBugs : plantedBugs.filter((bug) => only.includes(bug.key));
if (chosen.length === 0) {
  console.error(
    `No planted bug named ${only.join(", ")}. Known: ${plantedBugs.map((bug) => bug.key).join(", ")}`,
  );
  process.exit(1);
}

const { resolver } = await portalJson<{ resolver: string }>("/health");
console.log(`Portal at ${portal}, resolver: ${resolver}`);
if (resolver !== "real") {
  console.log("The fake Resolver solves nothing, so every row below will fail. Set RESOLVER=real.");
}

const marks: Mark[] = [];
for (const bug of chosen) {
  console.log(`\n  ${bug.key}: ${bug.what}`);
  try {
    const ticketId = await file(bug);
    console.log(`      ticket ${ticketId}`);
    const ticket = await runToClose(ticketId);
    if (ticket.status !== "closed") {
      console.log(`      gave up after ${Math.round(ticketTimeoutMs / 1000)}s in ${ticket.status}`);
    }
    marks.push(mark(bug, ticket));
  } catch (error) {
    console.log(`      could not be run: ${messageOf(error)}`);
    marks.push(mark(bug, { id: "—", category: null, outcome: null, confidence: null }));
  }
}

console.log(`\n${renderScorecard(marks)}\n`);
for (const found of marks.filter((row) => !row.pass)) {
  console.log(`${found.bug.key}: ${found.bug.because}`);
}

const passed = marks.filter((row) => row.pass).length;
console.log(`\n${passed}/${marks.length} planted bugs solved as expected.`);
process.exitCode = passed === marks.length ? 0 : 1;
