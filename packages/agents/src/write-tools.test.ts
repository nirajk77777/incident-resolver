import { describe, expect, it } from "vitest";
import {
  APPLY_DATA_FIX,
  CREATE_PULL_REQUEST,
  createWriteTools,
  type DataFixRequest,
  noGithubOpener,
  type OpenPullRequest,
  type PullRequestOpened,
  type PullRequestRequest,
  SEND_CUSTOMER_REPLY,
  type WriteEffects,
} from "./write-tools";

type Spy = WriteEffects & {
  fixes: DataFixRequest[];
  replies: string[];
  pullRequests: Array<{ request: PullRequestRequest; opened: PullRequestOpened }>;
};

function spyEffects(): Spy {
  const fixes: DataFixRequest[] = [];
  const replies: string[] = [];
  const pullRequests: Spy["pullRequests"] = [];
  return {
    fixes,
    replies,
    pullRequests,
    async applyDataFix(request) {
      fixes.push(request);
      return "Updated 1 row of shoplite.cart_totals.";
    },
    async sendCustomerReply({ text }) {
      replies.push(text);
      return `Sent: ${text}`;
    },
    async createPullRequest(request, opened) {
      pullRequests.push({ request, opened });
      return opened.ok ? `Opened ${opened.url}` : `Not opened: ${opened.reason}`;
    },
  };
}

const pullRequest = {
  title: "Fix the double discount",
  body: "## Root cause\nIt is applied twice.",
  files: ["src/discount.ts"],
};

const toolNamed = (name: string) => {
  const found = createWriteTools(spyEffects(), noGithubOpener).find(
    (candidate) => candidate.name === name,
  );
  if (!found) throw new Error(`No ${name} tool`);
  return found;
};

describe("the Resolver's write tools", () => {
  it("is exactly the three writes it can ask for", () => {
    expect(createWriteTools(spyEffects(), noGithubOpener).map((one) => one.name)).toEqual([
      APPLY_DATA_FIX,
      SEND_CUSTOMER_REPLY,
      CREATE_PULL_REQUEST,
    ]);
  });

  it("says in each description that a Reviewer decides first", () => {
    for (const one of createWriteTools(spyEffects(), noGithubOpener)) {
      expect(one.description).toMatch(/Reviewer/);
    }
  });

  it("hands the data fix to the effect and reports back what it did", async () => {
    const effects = spyEffects();
    const [fix] = createWriteTools(effects, noGithubOpener);
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
    const said = await createWriteTools(effects, noGithubOpener)[1]?.invoke({
      text: "We have corrected it.",
    });

    expect(effects.replies).toEqual(["We have corrected it."]);
    expect(said).toBe("Sent: We have corrected it.");
  });

  it("refuses a fix with no SQL and a Reply with no text", async () => {
    await expect(toolNamed(APPLY_DATA_FIX).invoke({ sql: "", reason: "" })).rejects.toThrow();
    await expect(toolNamed(SEND_CUSTOMER_REPLY).invoke({ text: "" })).rejects.toThrow();
  });

  it("opens the pull request and reports back what the effect recorded", async () => {
    const effects = spyEffects();
    const asked: PullRequestRequest[] = [];
    const open: OpenPullRequest = async (request) => {
      asked.push(request);
      return { ok: true, url: "https://github.com/n/s/pull/4", number: 4 };
    };
    const [, , pull] = createWriteTools(effects, open);

    const said = await pull?.invoke(pullRequest);

    expect(asked).toEqual([pullRequest]);
    expect(effects.pullRequests).toEqual([
      {
        request: pullRequest,
        opened: { ok: true, url: "https://github.com/n/s/pull/4", number: 4 },
      },
    ]);
    expect(said).toBe("Opened https://github.com/n/s/pull/4");
  });

  it("still records the attempt when there is no GitHub server to open it on", async () => {
    const effects = spyEffects();
    const [, , pull] = createWriteTools(effects, noGithubOpener);

    const said = await pull?.invoke(pullRequest);

    expect(effects.pullRequests[0]?.opened).toMatchObject({ ok: false });
    expect(said).toMatch(/Not opened/);
  });
});
