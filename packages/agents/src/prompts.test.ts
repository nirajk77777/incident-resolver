import { describe, expect, it, vi } from "vitest";
import {
  loadPrompt,
  type PromptFetcher,
  promptNames,
  promptVersions,
  readPromptFile,
  resolvePrompts,
} from "./prompts";

describe("loadPrompt", () => {
  it("loads every prompt the agents need from the prompts directory", () => {
    expect(promptNames).toEqual([
      "resolver",
      "triage",
      "log-investigator",
      "data-investigator",
      "incident-historian",
      "code-rca",
      "sentinel",
    ]);
    for (const name of promptNames) {
      const text = loadPrompt(name, { confidenceThreshold: 0.6 });
      expect(text.length).toBeGreaterThan(200);
      expect(text).not.toMatch(/\{\{\s*\w+\s*\}\}/);
    }
  });

  it("resolves only the prompts asked for, so Sentinel does not fetch the Resolver's", async () => {
    const fetch = vi.fn<PromptFetcher>(async () => undefined);
    const prompts = await resolvePrompts({ label: "production", names: ["sentinel"], fetch });

    expect(prompts.resolved.map((prompt) => prompt.name)).toEqual(["sentinel"]);
    expect(fetch).toHaveBeenCalledTimes(1);
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

describe("readPromptFile", () => {
  it("returns the markdown with its placeholders intact, which is what the sync pushes", () => {
    expect(readPromptFile("resolver")).toMatch(/\{\{confidenceThreshold\}\}/);
  });
});

describe("resolvePrompts", () => {
  const variables = { confidenceThreshold: 0.6 };

  it("reads every prompt from its file when Langfuse is not configured", async () => {
    const prompts = await resolvePrompts({ label: "production", variables });

    expect(prompts.label).toBe("production");
    expect(prompts.text("resolver")).toBe(loadPrompt("resolver", variables));
    expect(prompts.resolved.map((prompt) => prompt.name)).toEqual([...promptNames]);
    expect(prompts.resolved.every((prompt) => prompt.version === undefined)).toBe(true);
  });

  it("prefers the Langfuse version fetched by name and label", async () => {
    const fetch: PromptFetcher = async (name, label) => ({
      text: `# ${name} from ${label}, threshold {{confidenceThreshold}}`,
      version: 7,
    });

    const prompts = await resolvePrompts({ label: "staging", variables, fetch });

    expect(prompts.text("triage")).toBe("# triage from staging, threshold 0.6");
    expect(prompts.resolved.every((prompt) => prompt.version === 7)).toBe(true);
  });

  it("falls back to the local file for a prompt Langfuse does not have", async () => {
    const fetch: PromptFetcher = async (name) =>
      name === "resolver" ? { text: "# pushed", version: 2 } : undefined;
    const onFallback = vi.fn();

    const prompts = await resolvePrompts({ label: "production", variables, fetch, onFallback });

    expect(prompts.text("resolver")).toBe("# pushed");
    expect(prompts.text("triage")).toBe(loadPrompt("triage", variables));
    expect(onFallback).toHaveBeenCalledWith("triage", expect.stringMatching(/no version/i));
  });

  it("falls back to the local file when the fetch fails, so startup never depends on the network", async () => {
    const fetch: PromptFetcher = async () => {
      throw new Error("Langfuse unreachable");
    };
    const onFallback = vi.fn();

    const prompts = await resolvePrompts({ label: "production", variables, fetch, onFallback });

    expect(prompts.text("resolver")).toBe(loadPrompt("resolver", variables));
    expect(onFallback).toHaveBeenCalledWith("resolver", expect.stringMatching(/unreachable/));
  });

  it("falls back to the local file when a fetched prompt leaves a placeholder unfilled", async () => {
    const fetch: PromptFetcher = async () => ({ text: "# {{unknownVariable}}", version: 3 });
    const onFallback = vi.fn();

    const prompts = await resolvePrompts({ label: "production", variables, fetch, onFallback });

    expect(prompts.text("resolver")).toBe(loadPrompt("resolver", variables));
    expect(onFallback).toHaveBeenCalledWith("resolver", expect.stringMatching(/unknownVariable/));
  });

  it("names the prompt that is asked for but was never resolved", async () => {
    const prompts = await resolvePrompts({ label: "production", variables });
    expect(() => prompts.text("nope" as never)).toThrow(/nope/);
  });
});

describe("promptVersions", () => {
  it("says which version of each prompt the run used, for the trace", async () => {
    const fetch: PromptFetcher = async (name) =>
      name === "resolver" ? { text: "# pushed", version: 4 } : undefined;

    const prompts = await resolvePrompts({
      label: "production",
      variables: { confidenceThreshold: 0.6 },
      fetch,
    });

    expect(promptVersions(prompts)).toMatchObject({ resolver: "langfuse v4", triage: "file" });
  });
});
