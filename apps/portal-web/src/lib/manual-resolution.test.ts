import { describe, expect, it } from "vitest";
import { emptyResolution, resolutionFor, resolutionProblems } from "./manual-resolution";

const draft = {
  rootCause: "  The gateway timed out and left the order half-written.  ",
  resolution: "  Deleted the orphaned order row.  ",
  reply: "  The stuck order is cleared, please try again.  ",
  author: "  Priya  ",
};

describe("resolutionProblems", () => {
  it("asks for all three before anything is typed", () => {
    expect(resolutionProblems(emptyResolution)).toEqual([
      "Say what was actually wrong",
      "Say what fixed it",
      "Write the Reply the Reporter reads",
    ]);
  });

  it("does not ask for the Reviewer's name, which the portal can default", () => {
    expect(resolutionProblems({ ...draft, author: "" })).toEqual([]);
  });

  it("treats whitespace as nothing typed", () => {
    expect(resolutionProblems({ ...draft, resolution: "   " })).toEqual(["Say what fixed it"]);
  });
});

describe("resolutionFor", () => {
  it("trims every field", () => {
    expect(resolutionFor(draft)).toEqual({
      rootCause: "The gateway timed out and left the order half-written.",
      resolution: "Deleted the orphaned order row.",
      reply: "The stuck order is cleared, please try again.",
      author: "Priya",
    });
  });

  it("leaves an unnamed Reviewer out rather than sending a blank name", () => {
    expect(resolutionFor({ ...draft, author: "  " })).not.toHaveProperty("author");
  });

  it("is nothing at all while a field is missing", () => {
    expect(resolutionFor({ ...draft, reply: "" })).toBeUndefined();
  });
});
