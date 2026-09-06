import { describe, expect, it } from "vitest";
import { mark, type PlantedBug, plantedBugs, renderScorecard } from "./scorecard-plan";

const bug: PlantedBug = {
  key: "stale-cart-total",
  ticket: "packages/agents/tickets/stale-cart-total.json",
  what: "cart_totals goes stale when a line is removed",
  expectedCategory: "data_issue",
  expectedOutcomes: ["data_fixed"],
  because: "A past Incident documents the UPDATE",
};

const closed = {
  id: "50000000-0000-4000-8000-000000000003",
  category: "data_issue" as const,
  outcome: "data_fixed" as const,
  confidence: 0.82,
};

describe("plantedBugs", () => {
  it("covers every bug planted in ShopLite, each with a Ticket to file", () => {
    expect(plantedBugs.map((planted) => planted.key)).toEqual([
      "declined-card",
      "stale-cart-total",
      "double-discount",
      "empty-cart-crash",
    ]);
    for (const planted of plantedBugs) {
      expect(planted.ticket).toMatch(/^packages\/agents\/tickets\/.+\.json$/);
      expect(planted.expectedOutcomes.length).toBeGreaterThan(0);
    }
  });
});

describe("mark", () => {
  it("passes a Ticket that ended the way the bug should end", () => {
    expect(mark(bug, closed)).toMatchObject({ categoryPass: true, outcomePass: true, pass: true });
  });

  it("fails the Category the agent got wrong, and says so on its own", () => {
    const wrong = mark(bug, { ...closed, category: "code_bug" });

    expect(wrong).toMatchObject({ categoryPass: false, outcomePass: true, pass: false });
  });

  it("fails an Outcome the bug does not allow", () => {
    expect(mark(bug, { ...closed, outcome: "escalated" })).toMatchObject({
      outcomePass: false,
      pass: false,
    });
  });

  it("accepts any of the Outcomes a bug allows", () => {
    const midBuild: PlantedBug = { ...bug, expectedOutcomes: ["fix_proposed", "escalated"] };

    expect(mark(midBuild, { ...closed, outcome: "fix_proposed" }).outcomePass).toBe(true);
    expect(mark(midBuild, { ...closed, outcome: "escalated" }).outcomePass).toBe(true);
    expect(mark(midBuild, { ...closed, outcome: "answered" }).outcomePass).toBe(false);
  });

  it("fails a Ticket that never closed", () => {
    expect(mark(bug, { ...closed, category: null, outcome: null }).pass).toBe(false);
  });
});

describe("renderScorecard", () => {
  it("lines the columns up and says what was wanted where a row failed", () => {
    const table = renderScorecard([
      mark(bug, closed),
      mark(bug, { ...closed, outcome: "escalated", confidence: 0.4 }),
    ]);
    const [header, first, second] = table.split("\n");

    expect(header).toContain("bug");
    expect(first).toContain("pass");
    expect(second).toContain("FAIL");
    expect(second).toContain("want data_fixed");
    expect(second).toContain("0.40");
  });
});
