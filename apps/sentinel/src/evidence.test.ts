import type { LogEntry } from "@incident-resolver/mcp-observability";
import { describe, expect, it } from "vitest";
import { summarizeLines } from "./evidence";

const line = (over: Partial<LogEntry>): LogEntry => ({
  timestamp: "2026-09-07T12:00:00.000Z",
  level: "error",
  message: "Reduce of empty array with no initial value",
  traceId: "0af7651916cd43dd8448eb211c80319c",
  spanId: undefined,
  fields: {},
  ...over,
});

describe("summarizeLines", () => {
  it("groups the lines by message, most frequent first, and keeps their trace ids", () => {
    const evidence = summarizeLines([
      line({ traceId: "a".repeat(32) }),
      line({ traceId: "b".repeat(32) }),
      line({ message: "payment declined by gateway", level: "warn", traceId: "c".repeat(32) }),
    ]);

    expect(evidence.messages).toEqual([
      {
        level: "error",
        message: "Reduce of empty array with no initial value",
        count: 2,
        traceIds: ["a".repeat(32), "b".repeat(32)],
      },
      {
        level: "warn",
        message: "payment declined by gateway",
        count: 1,
        traceIds: ["c".repeat(32)],
      },
    ]);
  });

  it("collects the trace ids the Ticket is opened with, newest first and without repeats", () => {
    const evidence = summarizeLines([
      line({ traceId: "a".repeat(32) }),
      line({ traceId: "a".repeat(32) }),
      line({ traceId: "b".repeat(32) }),
      line({ traceId: undefined }),
    ]);

    expect(evidence.traceIds).toEqual(["a".repeat(32), "b".repeat(32)]);
  });

  it("caps how much it carries, since a Ticket body is read by a person", () => {
    const many = Array.from({ length: 40 }, (_, index) =>
      line({ traceId: String(index).padStart(32, "0") }),
    );

    expect(summarizeLines(many).traceIds).toHaveLength(5);
    expect(summarizeLines(many).messages[0]?.count).toBe(40);
  });

  it("says nothing rather than guessing when Loki had no lines", () => {
    expect(summarizeLines([])).toEqual({ traceIds: [], messages: [] });
  });
});
