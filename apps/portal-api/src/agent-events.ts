import type { StreamEvent } from "@langchain/core/tracers/log_stream";
import type { ResolverEvent } from "./resolver";

/**
 * Deep Agents reaches every subagent through this one tool, naming the subagent in its
 * arguments, so a `task` call is a subagent start and its return is that subagent's end.
 */
export const TASK_TOOL = "task";

/** How much of a subagent's answer a timeline card carries. Longer answers are cut. */
export const SUMMARY_LIMIT = 2_000;

/**
 * How much text one tool result carries onto the timeline. Log searches and SQL reads can
 * return a lot; the timeline is a record of what happened, not a copy of the data.
 */
export const RESULT_LIMIT = 8_000;

export type EventTranslator = (event: StreamEvent) => ResolverEvent | undefined;

/**
 * Turns the LangChain events of one Resolver run into the timeline entries the portal
 * writes. Tool events carry their run id but not the subagent they belong to, so the
 * translator remembers which run each `task` call opened and closes it on the way out;
 * one translator therefore belongs to exactly one run.
 *
 * Everything else the stream reports — model tokens, chain steps, retriever calls — is the
 * run's internals and does not reach the Reviewer.
 */
export function createEventTranslator(): EventTranslator {
  const subagentByRun = new Map<string, string>();

  return (event) => {
    if (event.event === "on_tool_start") {
      const args = toolInputOf(event.data.input);
      if (event.name !== TASK_TOOL) {
        return { type: "tool_call", name: event.name, args: jsonSafe(args) };
      }
      const name = subagentNameOf(args);
      if (name === undefined) return undefined;
      subagentByRun.set(event.run_id, name);
      return { type: "subagent_start", name };
    }

    if (event.event === "on_tool_end") {
      const name = subagentByRun.get(event.run_id);
      if (name !== undefined) {
        subagentByRun.delete(event.run_id);
        return { type: "subagent_end", name, summary: summaryOf(event.data.output) };
      }
      // A `task` call whose subagent was never named opened no card, so it closes none.
      if (event.name === TASK_TOOL) return undefined;
      return { type: "tool_result", name: event.name, result: resultOf(event.data.output) };
    }

    return undefined;
  };
}

/**
 * The arguments a tool was called with. The tracer reports them wrapped as `{ input }`, and
 * for a tool taking an object it is a JSON string inside that, so unwrapping here is what
 * makes a timeline card show the query that ran rather than an escaped copy of it.
 */
export function toolInputOf(input: unknown): unknown {
  const record = asRecord(input);
  const keys = record ? Object.keys(record) : [];
  const inner = keys.length === 1 && keys[0] === "input" ? record?.input : input;
  if (typeof inner !== "string") return inner;
  return parseJson(inner) ?? inner;
}

function subagentNameOf(args: unknown): string | undefined {
  const name = asRecord(args)?.subagent_type;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

/**
 * What a subagent answered, as one line of prose for its card. The `task` tool hands back a
 * LangGraph Command carrying the ToolMessage the Resolver will read, so the summary is the
 * content of that message; a subagent with structured output has already been serialised
 * into it.
 */
export function summaryOf(output: unknown): string | undefined {
  const text = textOf(lastMessageOf(output) ?? output);
  if (text === undefined || text.trim().length === 0) return undefined;
  return truncate(text.trim(), SUMMARY_LIMIT);
}

/**
 * What a tool returned, as something the timeline can store as JSON. MCP tools answer with
 * a message whose text is usually JSON, so it is parsed back into an object the portal can
 * render as a table rather than a wall of escaped quotes.
 */
export function resultOf(output: unknown): unknown {
  const text = textOf(output);
  if (text === undefined) return jsonSafe(output);
  if (text.length > RESULT_LIMIT) return truncate(text, RESULT_LIMIT);
  return parseJson(text) ?? text;
}

/** The last message of a LangGraph Command's state update, if this is one. */
function lastMessageOf(output: unknown): unknown {
  const messages = asRecord(asRecord(output)?.update)?.messages;
  return Array.isArray(messages) ? messages.at(-1) : undefined;
}

/** The text of a message, a list of content blocks, or a plain string. */
function textOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const blocks = value
      .map((block) => (typeof block === "string" ? block : blockText(block)))
      .filter((block) => block !== undefined);
    return blocks.length > 0 ? blocks.join("\n") : undefined;
  }
  const content = asRecord(value)?.content;
  return content === undefined ? undefined : textOf(content);
}

function blockText(block: unknown): string | undefined {
  const text = asRecord(block)?.text;
  return typeof text === "string" ? text : undefined;
}

function parseJson(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A value the timeline can store: `payload` is jsonb, so anything that does not survive a
 * round trip through JSON is kept as the text it prints as.
 */
function jsonSafe(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value ?? null)) as unknown;
  } catch {
    return String(value);
  }
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}… (${text.length} characters)`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}
