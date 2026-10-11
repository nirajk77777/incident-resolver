import { describe, expect, it } from "vitest";
import { formatSseFrame, SSE_KEEP_ALIVE } from "./sse";

describe("formatSseFrame", () => {
  const entry = {
    id: 12,
    run: 1,
    type: "tool_call" as const,
    payload: { name: "run_readonly_sql", args: { sql: "SELECT 1" } },
    createdAt: new Date("2026-09-06T10:00:00.000Z"),
  };

  it("sends the entry id so a reconnecting client can ask for what it missed", () => {
    expect(formatSseFrame(entry)).toMatch(/^id: 12\n/);
  });

  it("leaves the frame unnamed, so a plain EventSource receives the whole timeline", () => {
    expect(formatSseFrame(entry)).not.toContain("event:");
  });

  it("carries the entry as one line of JSON and ends the frame with a blank line", () => {
    const [, data] = /\ndata: (.*)\n\n$/.exec(formatSseFrame(entry)) ?? [];
    expect(JSON.parse(data ?? "")).toEqual({
      id: 12,
      run: 1,
      type: "tool_call",
      payload: { name: "run_readonly_sql", args: { sql: "SELECT 1" } },
      createdAt: "2026-09-06T10:00:00.000Z",
    });
  });

  it("has a comment frame to keep an idle connection open", () => {
    expect(SSE_KEEP_ALIVE).toBe(": keep-alive\n\n");
  });
});
