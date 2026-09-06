import { describe, expect, it } from "vitest";
import { loadPrompt, promptNames } from "./prompts";

describe("loadPrompt", () => {
  it("loads every prompt the agents need from the prompts directory", () => {
    expect(promptNames).toEqual(["resolver", "triage", "data-investigator"]);
    for (const name of promptNames) {
      const text = loadPrompt(name, { confidenceThreshold: 0.6 });
      expect(text.length).toBeGreaterThan(200);
      expect(text).not.toMatch(/\{\{\s*\w+\s*\}\}/);
    }
  });

  it("substitutes the Confidence threshold into the Resolver prompt", () => {
    expect(loadPrompt("resolver", { confidenceThreshold: 0.75 })).toContain("0.75");
  });

  it("refuses to leave a placeholder unfilled", () => {
    expect(() => loadPrompt("resolver", {})).toThrow(/confidenceThreshold/);
  });

  it("names the prompt when the file is missing", () => {
    expect(() => loadPrompt("nope" as never, {})).toThrow(/nope/);
  });
});
