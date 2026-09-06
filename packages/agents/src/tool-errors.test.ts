import { describe, expect, it } from "vitest";
import { createToolErrorGuard, toolErrorReply } from "./tool-errors";

describe("toolErrorReply", () => {
  it("hands the tool's own message back so the Investigator can correct the call", () => {
    const reply = toolErrorReply(
      new Error('Query failed: column "id" does not exist'),
      "run_readonly_sql",
    );

    expect(reply).toContain("run_readonly_sql");
    expect(reply).toContain('column "id" does not exist');
    expect(reply).toMatch(/correct the call/i);
  });

  it("says what to do when the call cannot be corrected, rather than inviting a guess", () => {
    expect(toolErrorReply(new Error("Loki is unreachable"), "search_logs")).toMatch(
      /report what you could not find out as Evidence/i,
    );
  });

  it("lets the run's deadline through: a timeout is not something the model can correct", () => {
    const timeout = Object.assign(new Error("The operation was aborted"), {
      name: "TimeoutError",
    });
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });

    expect(toolErrorReply(timeout, "run_readonly_sql")).toBeUndefined();
    expect(toolErrorReply(abort, "run_readonly_sql")).toBeUndefined();
  });
});

describe("createToolErrorGuard", () => {
  it("wraps tool calls, so it can be given to the Resolver and to each subagent", () => {
    expect(createToolErrorGuard().wrapToolCall).toBeTypeOf("function");
  });
});
