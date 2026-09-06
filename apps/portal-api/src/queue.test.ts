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

  it("delivers everything queued before it throws the failure", async () => {
    const queue = createEventQueue<number>();
    const seen: number[] = [];
    queue.push(1);
    queue.close(new Error("the run died"));

    await expect(
      (async () => {
        for await (const value of queue) seen.push(value);
      })(),
    ).rejects.toThrow("the run died");
    expect(seen).toEqual([1]);
  });

  it("ignores a push after the close, and a second close", async () => {
    const queue = createEventQueue<number>();
    queue.close();
    queue.close(new Error("too late"));
    queue.push(1);

    expect(await drain(queue)).toEqual([]);
  });
});
