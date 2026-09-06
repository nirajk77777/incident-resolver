import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseArgs, readTicket } from "./cli-args";

const fixture = (name: string) =>
  fileURLToPath(new URL(`../tickets/${name}.json`, import.meta.url));

describe("parseArgs", () => {
  it("takes the Ticket path and an optional thread id", () => {
    expect(parseArgs(["tickets/a.json"])).toEqual({ ticketPath: "tickets/a.json" });
    expect(parseArgs(["tickets/a.json", "--thread", "t1"])).toEqual({
      ticketPath: "tickets/a.json",
      threadId: "t1",
    });
  });

  it("explains usage when the path is missing or a flag is unknown", () => {
    expect(() => parseArgs([])).toThrow(/usage/i);
    expect(() => parseArgs(["a.json", "--verbose"])).toThrow(/--verbose/);
    expect(() => parseArgs(["a.json", "--thread"])).toThrow(/--thread/);
  });
});

describe("readTicket", () => {
  it("reads and validates the two demo Tickets shipped with the package", async () => {
    const images = await readTicket(fixture("images-not-loading"));
    expect(images.source).toBe("customer");
    expect(images.title).toMatch(/images/i);

    const declined = await readTicket(fixture("declined-card"));
    expect(declined.reporterEmail).toBe("ava.chen@example.com");
    expect(declined.title).toMatch(/checkout/i);
  });

  it("names the field when the Ticket JSON is invalid", async () => {
    const path = fileURLToPath(new URL("./cli-args.test.ts", import.meta.url));
    await expect(readTicket(path)).rejects.toThrow(/JSON/);
  });
});
