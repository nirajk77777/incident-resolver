import { ToolMessage } from "@langchain/core/messages";
import type { StreamEvent } from "@langchain/core/tracers/log_stream";
import { Command } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import { createEventTranslator, RESULT_LIMIT, SUMMARY_LIMIT, toolInputOf } from "./agent-events";

/** A LangChain stream event with only the fields the translator reads. */
function streamEvent(event: Partial<StreamEvent> & Pick<StreamEvent, "event">): StreamEvent {
  return { name: "tool", run_id: "run-1", metadata: {}, data: {}, ...event } as StreamEvent;
}

/**
 * How the tracer reports a tool's arguments: wrapped in `input`, and as a JSON string for a
 * tool that takes an object. This is what a real run's `on_tool_start` carries.
 */
const traced = (args: Record<string, unknown>) => ({ input: JSON.stringify(args) });

/** What Deep Agents' task tool hands back: a Command carrying the subagent's ToolMessage. */
function taskOutput(content: string): Command {
  return new Command({
    update: { messages: [new ToolMessage({ content, tool_call_id: "call-1", name: "task" })] },
  });
}

describe("createEventTranslator", () => {
  it("opens a subagent card on a task call and closes it on the same run", () => {
    const translate = createEventTranslator();

    expect(
      translate(
        streamEvent({
          event: "on_tool_start",
          name: "task",
          run_id: "task-run",
          data: { input: traced({ subagent_type: "triage", description: "Classify it" }) },
        }),
      ),
    ).toEqual({ type: "subagent_start", name: "triage" });

    expect(
      translate(
        streamEvent({
          event: "on_tool_end",
          name: "task",
          run_id: "task-run",
          data: { output: taskOutput("A declined card") },
        }),
      ),
    ).toEqual({ type: "subagent_end", name: "triage", summary: "A declined card" });
  });

  it("keeps concurrent Investigators apart by their run", () => {
    const translate = createEventTranslator();
    const start = (runId: string, name: string) =>
      translate(
        streamEvent({
          event: "on_tool_start",
          name: "task",
          run_id: runId,
          data: { input: traced({ subagent_type: name }) },
        }),
      );
    const end = (runId: string, content: string) =>
      translate(
        streamEvent({
          event: "on_tool_end",
          name: "task",
          run_id: runId,
          data: { output: taskOutput(content) },
        }),
      );

    start("a", "log-investigator");
    start("b", "data-investigator");

    expect(end("b", "The order was never paid")).toEqual({
      type: "subagent_end",
      name: "data-investigator",
      summary: "The order was never paid",
    });
    expect(end("a", "The gateway declined it")).toEqual({
      type: "subagent_end",
      name: "log-investigator",
      summary: "The gateway declined it",
    });
  });

  it("reports every other tool as a call and a result", () => {
    const translate = createEventTranslator();
    const args = { sql: "SELECT 1" };

    expect(
      translate(
        streamEvent({
          event: "on_tool_start",
          name: "run_readonly_sql",
          run_id: "sql-run",
          data: { input: traced(args) },
        }),
      ),
    ).toEqual({ type: "tool_call", name: "run_readonly_sql", args });

    expect(
      translate(
        streamEvent({
          event: "on_tool_end",
          name: "run_readonly_sql",
          run_id: "sql-run",
          data: {
            output: new ToolMessage({
              content: JSON.stringify({ rowCount: 1 }),
              tool_call_id: "call-2",
            }),
          },
        }),
      ),
    ).toEqual({ type: "tool_result", name: "run_readonly_sql", result: { rowCount: 1 } });
  });

  it("keeps a tool result that is not JSON as its text", () => {
    const translate = createEventTranslator();
    const output = new ToolMessage({ content: "no lines matched", tool_call_id: "call-3" });

    expect(
      translate(streamEvent({ event: "on_tool_end", name: "search_logs", data: { output } })),
    ).toEqual({ type: "tool_result", name: "search_logs", result: "no lines matched" });
  });

  it("reads a result out of standard content blocks", () => {
    const translate = createEventTranslator();
    const output = { content: [{ type: "text", text: '{"lines":[]}' }] };

    expect(
      translate(streamEvent({ event: "on_tool_end", name: "search_logs", data: { output } })),
    ).toEqual({ type: "tool_result", name: "search_logs", result: { lines: [] } });
  });

  it("cuts a result that would fill the timeline", () => {
    const translate = createEventTranslator();
    const output = new ToolMessage({ content: "x".repeat(RESULT_LIMIT + 10), tool_call_id: "c" });

    const entry = translate(
      streamEvent({ event: "on_tool_end", name: "search_logs", data: { output } }),
    );

    expect(entry?.type).toBe("tool_result");
    const result = entry?.type === "tool_result" ? String(entry.result) : "";
    expect(result.startsWith("x".repeat(RESULT_LIMIT))).toBe(true);
    expect(result).toContain(`(${RESULT_LIMIT + 10} characters)`);
  });

  it("cuts a subagent summary that would fill the timeline", () => {
    const translate = createEventTranslator();
    translate(
      streamEvent({
        event: "on_tool_start",
        name: "task",
        data: { input: traced({ subagent_type: "triage" }) },
      }),
    );

    const entry = translate(
      streamEvent({
        event: "on_tool_end",
        name: "task",
        data: { output: taskOutput("y".repeat(SUMMARY_LIMIT + 5)) },
      }),
    );

    expect(entry?.type === "subagent_end" && entry.summary?.length).toBeGreaterThan(SUMMARY_LIMIT);
    expect(entry?.type === "subagent_end" && entry.summary).toContain("characters)");
  });

  it("leaves a subagent that answered nothing without a summary", () => {
    const translate = createEventTranslator();
    translate(
      streamEvent({
        event: "on_tool_start",
        name: "task",
        data: { input: traced({ subagent_type: "triage" }) },
      }),
    );

    expect(
      translate(streamEvent({ event: "on_tool_end", name: "task", data: { output: undefined } })),
    ).toEqual({ type: "subagent_end", name: "triage", summary: undefined });
  });

  it("ignores a task call that names no subagent, and its return", () => {
    const translate = createEventTranslator();

    expect(
      translate(
        streamEvent({
          event: "on_tool_start",
          name: "task",
          data: { input: traced({ description: "?" }) },
        }),
      ),
    ).toBeUndefined();
    expect(
      translate(streamEvent({ event: "on_tool_end", name: "task", data: { output: "done" } })),
    ).toBeUndefined();
  });

  it("reads arguments a tracer reported unwrapped, whatever shape they arrive in", () => {
    const translate = createEventTranslator();

    expect(
      translate(
        streamEvent({
          event: "on_tool_start",
          name: "task",
          data: { input: { subagent_type: "triage" } },
        }),
      ),
    ).toEqual({ type: "subagent_start", name: "triage" });
  });

  it("ignores the model and chain events a run is otherwise made of", () => {
    const translate = createEventTranslator();
    const ignored = ["on_chain_start", "on_chat_model_stream", "on_chat_model_end", "on_chain_end"];

    for (const event of ignored) {
      expect(translate(streamEvent({ event }))).toBeUndefined();
    }
  });
});

describe("toolInputOf", () => {
  it("unwraps the tracer's `input`, parsing the JSON a tool taking an object is called with", () => {
    expect(toolInputOf({ input: '{"sql":"SELECT 1"}' })).toEqual({ sql: "SELECT 1" });
    expect(toolInputOf({ input: { sql: "SELECT 1" } })).toEqual({ sql: "SELECT 1" });
  });

  it("keeps a tool called with plain text as that text", () => {
    expect(toolInputOf({ input: "checkout failed" })).toBe("checkout failed");
  });

  it("leaves arguments that were never wrapped alone", () => {
    expect(toolInputOf({ sql: "SELECT 1", input: "unrelated" })).toEqual({
      sql: "SELECT 1",
      input: "unrelated",
    });
    expect(toolInputOf(undefined)).toBeUndefined();
  });
});
