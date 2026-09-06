/**
 * A channel from one writer to one reader. The Resolver's stream arrives through a callback
 * and leaves as an async iterable, and this is the join between the two: the run pushes as
 * it goes, the timeline pulls, and neither waits on the other.
 *
 * One reader only. Two iterators would each wake on some pushes and miss the rest.
 */
export type EventQueue<T> = {
  push(value: T): void;
  /** Ends the iteration once what is already queued has been read. */
  close(error?: unknown): void;
  [Symbol.asyncIterator](): AsyncIterator<T>;
};

export function createEventQueue<T>(): EventQueue<T> {
  const waiting: T[] = [];
  let closed = false;
  let failure: unknown;
  let wake: (() => void) | undefined;

  function notify(): void {
    const pending = wake;
    wake = undefined;
    pending?.();
  }

  return {
    push(value) {
      if (closed) return;
      waiting.push(value);
      notify();
    },

    close(error) {
      if (closed) return;
      closed = true;
      failure = error;
      notify();
    },

    async *[Symbol.asyncIterator]() {
      while (true) {
        while (waiting.length > 0) yield waiting.shift() as T;
        // Everything queued before the close is delivered; only then does the failure land.
        if (closed) {
          if (failure !== undefined) throw failure;
          return;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}
