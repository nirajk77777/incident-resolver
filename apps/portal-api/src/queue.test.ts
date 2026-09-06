import { describe, expect, it } from "vitest";
import { createEventQueue } from "./queue";

async function drain<T>(queue: AsyncIterable<T>): Promise<T[]> {
  const seen: T[] = [];
  for await (const value of queue) seen.push(value);
  return seen;
}

describe("createEventQueue", () => {
  it("delivers what was pushed before the reader arrived", async () => {
    const queue = createEventQueue<number>();
    queue.push(1);
    queue.push(2);
    queue.close();

    expect(await drain(queue)).toEqual([1, 2]);
  });

  it("wakes a waiting reader when a value arrives", async () => {
    const queue = createEventQueue<string>();
    const read = drain(queue);

    queue.push("triage");
    await Promise.resolve();
    queue.push("verdict");
    queue.close();

    expect(await read).toEqual(["triage", "verdict"]);
  });

  it("ignores a push after the close, and a second close", async () => {
    const queue = createEventQueue<number>();
    queue.close();
    queue.close();
    queue.push(1);

    expect(await drain(queue)).toEqual([]);
  });
});
