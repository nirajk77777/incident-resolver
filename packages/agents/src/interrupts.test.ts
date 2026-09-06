import type { Ticket } from "@incident-resolver/shared";
import { describe, expect, it } from "vitest";
import { gatedTools, interruptsFor } from "./interrupts";

const ticket = (source: Ticket["source"]): Ticket => ({
  id: "3f7c1b52-8f0f-4a9f-9b1a-2c9d5e6f7a80",
  source,
  ...(source === "customer" ? { reporterEmail: "ava.chen@example.com" } : {}),
  title: "Cart total wrong",
  body: "Removing an item leaves the badge stale",
});

describe("the gate", () => {
  it("covers every write the agent cannot make on its own", () => {
    expect(Object.keys(gatedTools)).toEqual([
      "apply_data_fix",
      "create_pull_request",
      "send_customer_reply",
    ]);
  });

  it("offers each action the Decisions its policy allows", () => {
    expect(gatedTools.apply_data_fix.allowedDecisions).toEqual(["approve", "edit", "reject"]);
    expect(gatedTools.create_pull_request.allowedDecisions).toEqual(["approve", "reject"]);
    expect(gatedTools.send_customer_reply.allowedDecisions).toEqual(["approve", "edit"]);
  });
});

describe("the gate for one Ticket", () => {
  it("reviews the Reply of a customer Ticket, which is the one that gets sent", () => {
    expect(Object.keys(interruptsFor(ticket("customer")))).toContain("send_customer_reply");
  });

  it("leaves a tester's and Sentinel's internal note alone, and still gates every write", () => {
    for (const source of ["tester", "sentinel"] as const) {
      const gate = Object.keys(interruptsFor(ticket(source)));
      expect(gate).not.toContain("send_customer_reply");
      expect(gate).toEqual(["apply_data_fix", "create_pull_request"]);
    }
  });
});
