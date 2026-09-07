import type { NewIncident } from "@incident-resolver/mcp-incidents";
import type { ManualResolution, Verdict } from "@incident-resolver/shared";
import { describe, expect, it, vi } from "vitest";
import {
  createIncidentWriter,
  type IncidentSource,
  incidentFromResolution,
  incidentFromVerdict,
  resolutionOf,
} from "./incidents";

const ticket: IncidentSource = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Cart total wrong after removing an item",
  body: "The badge still says 2 items after I removed one.",
  category: "data_issue",
};

const verdict: Verdict = {
  outcome: "data_fixed",
  category: "data_issue",
  confidence: 0.91,
  rootCause: "cart_totals was not refreshed when the item was removed.",
  evidence: [
    { fact: "cart_totals holds 2 items, cart_items holds 1", provenance: "run_readonly_sql" },
  ],
  reply: "We have corrected the total on your cart.",
};

describe("incidentFromVerdict", () => {
  const incident = incidentFromVerdict(ticket, verdict);

  it("is marked resolved by the agent and points back at the Ticket", () => {
    expect(incident).toMatchObject({
      title: ticket.title,
      rootCause: verdict.rootCause,
      category: "data_issue",
      sourceTicketId: ticket.id,
      resolvedBy: "agent",
      author: "Resolver",
    });
  });

  it("keeps the Reporter's own words as the symptoms, with the Evidence under them", () => {
    expect(incident.symptoms).toContain(ticket.body);
    expect(incident.symptoms).toContain("cart_totals holds 2 items");
    expect(incident.symptoms).toContain("run_readonly_sql");
  });

  it("says what settled it and then says it in the words the Reporter read", () => {
    expect(incident.resolution).toBe(resolutionOf(verdict));
    expect(incident.resolution).toContain("An approved data fix corrected the rows.");
    expect(incident.resolution).toContain(verdict.reply);
  });

  it("takes the Category from the Verdict, which the Evidence confirmed or corrected", () => {
    const corrected = incidentFromVerdict({ ...ticket, category: "unknown" }, verdict);
    expect(corrected.category).toBe("data_issue");
  });
});

describe("incidentFromResolution", () => {
  const resolution: ManualResolution = {
    rootCause: "The gateway timed out and left the order half-written.",
    resolution: "Deleted the orphaned order row.",
    reply: "The stuck order is cleared, please try again.",
    author: "Priya",
  };

  it("is marked resolved by the human who wrote it, in their words", () => {
    expect(incidentFromResolution(ticket, resolution)).toMatchObject({
      title: ticket.title,
      symptoms: ticket.body,
      rootCause: resolution.rootCause,
      resolution: resolution.resolution,
      category: "data_issue",
      sourceTicketId: ticket.id,
      resolvedBy: "human",
      author: "Priya",
    });
  });

  it("falls back to an unknown Category when the run escalated before Triage settled one", () => {
    expect(incidentFromResolution({ ...ticket, category: null }, resolution).category).toBe(
      "unknown",
    );
  });
});

/** A log that swallows what it is given; only `error` is read back. */
const log = () =>
  ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) as unknown as Parameters<
    typeof createIncidentWriter
  >[0]["log"];

const knowledge = (overrides: Record<string, unknown> = {}) =>
  ({
    insertIncident: vi.fn(async (incident: NewIncident) => ({ ...incident, id: "written" })),
    deleteIncidentsForTicket: vi.fn(async () => 1),
    ...overrides,
  }) as unknown as Parameters<typeof createIncidentWriter>[0]["store"];

const embedder = (vector: number[] | null = [0.1, 0.2]) =>
  ({
    embedDocuments: vi.fn(async () => (vector ? [vector] : [])),
  }) as unknown as Parameters<typeof createIncidentWriter>[0]["embedder"];

describe("createIncidentWriter", () => {
  it("embeds the record and replaces whatever this Ticket had already written", async () => {
    const store = knowledge();
    const embed = embedder();
    const incident = incidentFromVerdict(ticket, verdict);

    await createIncidentWriter({ store, embedder: embed, log: log() }).write(incident);

    expect(embed.embedDocuments).toHaveBeenCalledOnce();
    expect(store.deleteIncidentsForTicket).toHaveBeenCalledWith(ticket.id);
    expect(store.insertIncident).toHaveBeenCalledWith(incident, [0.1, 0.2]);
  });

  it("logs and carries on when the knowledge base cannot be written: the Ticket still closes", async () => {
    const store = knowledge({
      insertIncident: vi.fn(async () => {
        throw new Error("pgvector is down");
      }),
    });
    const logger = log();

    await expect(
      createIncidentWriter({ store, embedder: embedder(), log: logger }).write(
        incidentFromVerdict(ticket, verdict),
      ),
    ).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });

  it("writes nothing when the embedder returns no vector", async () => {
    const store = knowledge();
    await createIncidentWriter({ store, embedder: embedder(null), log: log() }).write(
      incidentFromVerdict(ticket, verdict),
    );
    expect(store.insertIncident).not.toHaveBeenCalled();
  });
});
