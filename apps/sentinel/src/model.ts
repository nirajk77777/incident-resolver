import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import type { TicketComposer } from "./ticket-text";

/**
 * The one place Sentinel talks to a model, on `MODEL_SENTINEL` (gpt-5.4-nano by default):
 * it is given the brief and asked for a title and a body, and nothing else. Structured
 * output rather than free text, so a reply that is not a Ticket is a parse failure the
 * writer falls back from rather than a Ticket with a preamble in its title.
 */

const ticketTextSchema = z.object({
  title: z.string().min(1).describe("One line naming the route and how badly it is failing"),
  body: z
    .string()
    .min(1)
    .describe("Two short paragraphs: what is happening, and what the logs said"),
});

export type ModelComposerOptions = {
  model: string;
  apiKey: string;
  /** The Sentinel prompt, from Langfuse or from `packages/agents/prompts/sentinel.md`. */
  systemPrompt: string;
};

export function createModelComposer({
  model,
  apiKey,
  systemPrompt,
}: ModelComposerOptions): TicketComposer {
  const chat = new ChatOpenAI({ model, apiKey }).withStructuredOutput(ticketTextSchema, {
    name: "sentinel_ticket",
  });
  return async (brief) =>
    chat.invoke([
      { role: "system", content: systemPrompt },
      { role: "user", content: brief },
    ]);
}
