import { describe, expect, it } from "vitest";
import { awaitsManualResolution, manualResolutionSchema, type Settled } from "./resolution";

const resolution = {
  rootCause: "The gateway timed out and the order was left half-written.",
  resolution: "Deleted the orphaned order row and told the Reporter to check out again.",
  reply: "Sorry about that. The stuck order is cleared, please try again.",
};

describe("manualResolutionSchema", () => {
  it("takes the three things a Reviewer writes, and names them as the Reviewer by default", () => {
    expect(manualResolutionSchema.parse(resolution)).toEqual({
      ...resolution,
      author: "Reviewer",
    });
  });

  it("keeps the author when one is given", () => {
    const named = manualResolutionSchema.parse({ ...resolution, author: "Priya" });
    expect(named.author).toBe("Priya");
  });

  it("refuses an empty field: an Incident with a blank root cause teaches nothing", () => {
    for (const blank of ["rootCause", "resolution", "reply"]) {
      expect(manualResolutionSchema.safeParse({ ...resolution, [blank]: "" }).success).toBe(false);
    }
  });
});

describe("awaitsManualResolution", () => {
  const escalated: Settled = { status: "closed", outcome: "escalated", resolvedBy: null };

  it("is true for an escalated Ticket no person has picked up", () => {
    expect(awaitsManualResolution(escalated)).toBe(true);
  });

  it("is false once a person has resolved it", () => {
    expect(awaitsManualResolution({ ...escalated, resolvedBy: "human" })).toBe(false);
  });

  it("is false for a Ticket the Resolver settled, and for one still running", () => {
    expect(awaitsManualResolution({ ...escalated, outcome: "answered", resolvedBy: "agent" })).toBe(
      false,
    );
    expect(
      awaitsManualResolution({ status: "investigating", outcome: null, resolvedBy: null }),
    ).toBe(false);
  });
});
