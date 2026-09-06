import { describe, expect, it } from "vitest";
import { incidentDocument } from "./documents";
import {
  authors,
  cartTotalsRecomputeSql,
  seedHelpArticleIds,
  seedHelpArticles,
  seedIncidentIds,
  seedIncidents,
} from "./seed-data";

const DAY = 24 * 60 * 60 * 1000;

describe("seeded Incidents", () => {
  it("are twenty, with unique ids and titles", () => {
    expect(seedIncidents).toHaveLength(20);
    expect(new Set(seedIncidents.map((incident) => incident.id)).size).toBe(20);
    expect(new Set(seedIncidents.map((incident) => incident.title)).size).toBe(20);
  });

  it("are dated across six months by three authors, resolved by both the agent and humans", () => {
    const times = seedIncidents.map((incident) => incident.createdAt.getTime());
    const spanDays = (Math.max(...times) - Math.min(...times)) / DAY;
    expect(spanDays).toBeGreaterThanOrEqual(150);
    expect(spanDays).toBeLessThanOrEqual(200);

    expect(new Set(seedIncidents.map((incident) => incident.author))).toEqual(
      new Set(Object.values(authors)),
    );
    expect(new Set(seedIncidents.map((incident) => incident.resolvedBy))).toEqual(
      new Set(["agent", "human"]),
    );
    for (const incident of seedIncidents) {
      expect(incident.resolvedBy === "agent").toBe(incident.author === authors.resolver);
    }
  });

  it("cover several Categories", () => {
    const categories = new Set(seedIncidents.map((incident) => incident.category));
    expect(categories.size).toBeGreaterThanOrEqual(5);
  });

  it("document the stale cart total fix as a runnable UPDATE on cart_totals", () => {
    const canonical = seedIncidents.find((i) => i.id === seedIncidentIds.staleCartTotal);
    expect(canonical?.category).toBe("data_issue");
    expect(canonical?.resolution).toContain(cartTotalsRecomputeSql);
    expect(cartTotalsRecomputeSql).toMatch(/^UPDATE shoplite\.cart_totals/);
    expect(cartTotalsRecomputeSql).toMatch(/WHERE cart_id = /);
    for (const column of ["item_count", "subtotal_cents", "total_cents", "updated_at"]) {
      expect(cartTotalsRecomputeSql).toContain(column);
    }
  });

  it("include two near-duplicates of the stale cart total Incident and one red herring", () => {
    const byId = new Map(seedIncidents.map((incident) => [incident.id, incident]));
    const duplicates = seedIncidentIds.staleCartTotalDuplicates.map((id) => byId.get(id));
    expect(duplicates).toHaveLength(2);
    for (const duplicate of duplicates) {
      expect(duplicate?.category).toBe("data_issue");
      expect(incidentDocument(duplicate as NonNullable<typeof duplicate>)).toMatch(/cart_totals/);
    }

    const redHerring = byId.get(seedIncidentIds.redHerring);
    expect(redHerring?.category).not.toBe("data_issue");
    expect(redHerring?.title.toLowerCase()).toContain("cart total wrong after removing item");
    expect(incidentDocument(redHerring as NonNullable<typeof redHerring>)).not.toMatch(
      /cart_totals/,
    );
  });
});

describe("seeded Help articles", () => {
  it("are about ten, with unique ids, titles, and at least one tag each", () => {
    expect(seedHelpArticles.length).toBeGreaterThanOrEqual(8);
    expect(seedHelpArticles.length).toBeLessThanOrEqual(12);
    expect(new Set(seedHelpArticles.map((article) => article.id)).size).toBe(
      seedHelpArticles.length,
    );
    for (const article of seedHelpArticles) {
      expect(article.tags.length).toBeGreaterThan(0);
      expect(article.body.length).toBeGreaterThan(80);
    }
  });

  it("cover the topics the plan lists", () => {
    const titles = seedHelpArticles.map((article) => article.title.toLowerCase()).join("\n");
    for (const topic of [
      "clear your cache",
      "password",
      "address",
      "cancel",
      "invoice",
      "cards",
      "discount code",
    ]) {
      expect(titles).toContain(topic);
    }
  });

  it("answer images not loading with the clear cache article", () => {
    const article = seedHelpArticles.find((a) => a.id === seedHelpArticleIds.clearCache);
    expect(article?.title).toMatch(/images/i);
    expect(article?.body).toMatch(/hard refresh/i);
  });
});
