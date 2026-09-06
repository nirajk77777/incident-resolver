import { describe, expect, it } from "vitest";
import { reportBody, reportProblems, STEPS_HEADING } from "./report";

const report = { summary: "Cart total wrong", what: "The badge keeps the old total." };

describe("reportBody", () => {
  it("is what the tester wrote when they gave no steps", () => {
    expect(reportBody(report)).toBe("The badge keeps the old total.");
    expect(reportBody({ ...report, steps: "   " })).toBe("The badge keeps the old total.");
  });

  it("folds the steps in under a heading the Resolver can see", () => {
    const body = reportBody({ ...report, steps: "1. Add an item\n2. Remove it" });

    expect(body).toBe(
      `The badge keeps the old total.\n\n${STEPS_HEADING}:\n1. Add an item\n2. Remove it`,
    );
  });

  it("trims what the tester typed", () => {
    expect(reportBody({ ...report, what: "  spaced  ", steps: "  a step  " })).toBe(
      `spaced\n\n${STEPS_HEADING}:\na step`,
    );
  });
});

describe("reportProblems", () => {
  it("is empty once the summary and the report are both there", () => {
    expect(reportProblems(report)).toEqual([]);
  });

  it("names each missing field, in the order they are asked for", () => {
    expect(reportProblems({ summary: " ", what: "" })).toEqual([
      "Give the report a summary",
      "Say what went wrong",
    ]);
  });
});
