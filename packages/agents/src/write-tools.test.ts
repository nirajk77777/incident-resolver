import { describe, expect, it } from "vitest";
import {
  APPLY_DATA_FIX,
  createWriteTools,
  type DataFixRequest,
  SEND_CUSTOMER_REPLY,
  type WriteEffects,
} from "./write-tools";

function spyEffects(): WriteEffects & { fixes: DataFixRequest[]; replies: string[] } {
  const fixes: DataFixRequest[] = [];
  const replies: string[] = [];
  return {
    fixes,
    replies,
    async applyDataFix(request) {
      fixes.push(request);
      return "Updated 1 row of shoplite.cart_totals.";
    },
    async sendCustomerReply({ text }) {
      replies.push(text);
      return `Sent: ${text}`;
    },
  };
}

const toolNamed = (name: string) => {
  const found = createWriteTools(spyEffects()).find((candidate) => candidate.name === name);
  if (!found) throw new Error(`No ${name} tool`);
  return found;
};

describe("the Resolver's write tools", () => {
  it("is exactly the two writes it can ask for", () => {
    expect(createWriteTools(spyEffects()).map((one) => one.name)).toEqual([
      APPLY_DATA_FIX,
      SEND_CUSTOMER_REPLY,
    ]);
  });

  it("says in each description that a Reviewer decides first", () => {
    for (const one of createWriteTools(spyEffects())) {
      expect(one.description).toMatch(/Reviewer/);
    }
  });

  it("hands the data fix to the effect and reports back what it did", async () => {
    const effects = spyEffects();
    const [fix] = createWriteTools(effects);
    const said = await fix?.invoke({
      sql: "UPDATE shoplite.cart_totals SET total_cents = 1200 WHERE cart_id = '1'",
      reason: "The badge is stale",
    });

    expect(effects.fixes).toEqual([
      {
        sql: "UPDATE shoplite.cart_totals SET total_cents = 1200 WHERE cart_id = '1'",
        reason: "The badge is stale",
      },
    ]);
    expect(said).toBe("Updated 1 row of shoplite.cart_totals.");
  });

  it("hands the Reply to the effect and reports back the text that was sent", async () => {
    const effects = spyEffects();
    const said = await createWriteTools(effects)[1]?.invoke({ text: "We have corrected it." });

    expect(effects.replies).toEqual(["We have corrected it."]);
    expect(said).toBe("Sent: We have corrected it.");
  });

  it("refuses a fix with no SQL and a Reply with no text", async () => {
    await expect(toolNamed(APPLY_DATA_FIX).invoke({ sql: "", reason: "" })).rejects.toThrow();
    await expect(toolNamed(SEND_CUSTOMER_REPLY).invoke({ text: "" })).rejects.toThrow();
  });
});
