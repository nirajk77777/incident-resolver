import type { Ticket } from "@incident-resolver/shared";
import { describe, expect, it } from "vitest";
import { startTracing, traceTags } from "./tracing";

const ticket: Ticket = {
  id: "50000000-0000-4000-8000-000000000001",
  source: "customer",
  reporterEmail: "ava.chen@example.com",
  title: "t",
  body: "b",
};

describe("traceTags", () => {
  it("tags the trace with the Source, the models, and the Category once known", () => {
    const models = { resolver: "gpt-5.4", triage: "gpt-5.4-mini", investigator: "gpt-5.4-mini" };
    expect(traceTags(ticket, models)).toEqual([
      "source:customer",
      "model:gpt-5.4",
      "model:gpt-5.4-mini",
    ]);
    expect(traceTags(ticket, models, "question")).toEqual([
      "source:customer",
      "model:gpt-5.4",
      "model:gpt-5.4-mini",
      "category:question",
    ]);
  });
});

describe("startTracing", () => {
  it("stays disabled without Langfuse keys and still shuts down cleanly", async () => {
    const tracing = startTracing({ baseUrl: "https://cloud.langfuse.com" });
    expect(tracing.enabled).toBe(false);
    await expect(tracing.shutdown()).resolves.toBeUndefined();
  });
});
