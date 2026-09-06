import { describe, expect, it } from "vitest";
import { createPromptClient, isNotFound } from "./langfuse-prompts";

describe("createPromptClient", () => {
  it("has no client without both Langfuse keys, so prompts come from their files", () => {
    expect(createPromptClient({})).toBeUndefined();
    expect(createPromptClient({ publicKey: "pk" })).toBeUndefined();
    expect(createPromptClient({ secretKey: "sk" })).toBeUndefined();
  });

  it("builds a client when both keys are set", () => {
    const client = createPromptClient({
      publicKey: "pk-lf-test",
      secretKey: "sk-lf-test",
      baseUrl: "https://cloud.langfuse.com",
    });
    expect(client?.prompt).toBeDefined();
  });
});

describe("isNotFound", () => {
  it("tells a missing label apart from a key or network failure", () => {
    expect(isNotFound(Object.assign(new Error("not found"), { statusCode: 404 }))).toBe(true);
    expect(isNotFound(Object.assign(new Error("unauthorized"), { statusCode: 401 }))).toBe(false);
    expect(isNotFound(new Error("fetch failed"))).toBe(false);
    expect(isNotFound(undefined)).toBe(false);
  });
});
