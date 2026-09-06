import { describe, expect, it } from "vitest";
import { draftBody, draftProblems, STEPS_HEADING } from "./draft";

const draft = { summary: "Cart total wrong", what: "The badge keeps the old total." };

describe("draftBody", () => {
  it("is what the tester wrote when they gave no steps", () => {
    expect(draftBody(draft)).toBe("The badge keeps the old total.");
    expect(draftBody({ ...draft, steps: "   " })).toBe("The badge keeps the old total.");
  });

  it("folds the steps in under a heading the Resolver can see", () => {
    const body = draftBody({ ...draft, steps: "1. Add an item\n2. Remove it" });

    expect(body).toBe(
      `The badge keeps the old total.\n\n${STEPS_HEADING}:\n1. Add an item\n2. Remove it`,
    );
  });

  it("trims what the tester typed", () => {
    expect(draftBody({ ...draft, what: "  spaced  ", steps: "  a step  " })).toBe(
      `spaced\n\n${STEPS_HEADING}:\na step`,
    );
  });
});

describe("draftProblems", () => {
  it("is empty once the summary and what went wrong are both there", () => {
    expect(draftProblems(draft)).toEqual([]);
  });

  it("names each missing field, in the order they are asked for", () => {
    expect(draftProblems({ summary: " ", what: "" })).toEqual([
      "Give the ticket a summary",
      "Say what went wrong",
    ]);
  });
});
