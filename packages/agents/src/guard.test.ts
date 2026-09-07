import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { createProcedureGuard, delegationRefusal, FOCUS_HEADING, withTriageFocus } from "./guard";
import type { Triage } from "./schemas";
import { CODE_RCA, FIX_SHIPPER, investigators } from "./subagents";

const question: Triage = {
  category: "question",
  severity: "low",
  component: "storefront",
  hypothesis: "cache",
  confidence: 0.9,
  helpArticleIds: ["40000000-0000-4000-8000-000000000001"],
  bestHelpArticle: {
    id: "40000000-0000-4000-8000-000000000001",
    title: "Clear your cache",
    body: "Hard refresh.",
  },
};

const dataIssue: Triage = {
  ...question,
  category: "data_issue",
  component: "cart",
  hypothesis: "cart_totals is stale after the removal; check cart_items against cart_totals.",
  helpArticleIds: [],
  bestHelpArticle: null,
};

/** The procedure as a run with neither a Workspace nor GitHub sees it: neither subagent exists. */
const procedure = { confidenceThreshold: 0.6, codeRca: false, fixShipper: false };
/** The same run with both, which is what makes Code RCA and the Fix Shipper subagents. */
const withCodeRca = { confidenceThreshold: 0.6, codeRca: true, fixShipper: true };
/** A Workspace but no GitHub token: the bug can be found and the fix cannot be shipped. */
const withoutGithub = { confidenceThreshold: 0.6, codeRca: true, fixShipper: false };

const task = (subagent: string, id = "call") => ({
  id,
  name: "task",
  args: { description: "do it", subagent_type: subagent },
});

function afterTriage(triage: Triage) {
  return [
    new HumanMessage("ticket"),
    new AIMessage({ content: "", tool_calls: [task("triage", "t1")] }),
    new ToolMessage({ tool_call_id: "t1", name: "task", content: JSON.stringify(triage) }),
  ];
}

/** The three Investigators as the Resolver is told to launch them: one turn, three calls. */
function fanOut(triage: Triage) {
  return [
    ...afterTriage(triage),
    new AIMessage({
      content: "",
      tool_calls: investigators.map((name) => task(name, `call-${name}`)),
    }),
  ];
}

/** The point in a run where all three Investigators have reported and the Evidence is in. */
function afterInvestigation(triage: Triage) {
  return [
    ...fanOut(triage),
    ...investigators.map(
      (name) => new ToolMessage({ tool_call_id: `call-${name}`, name: "task", content: "{}" }),
    ),
  ];
}

describe("delegationRefusal", () => {
  it("lets any tool other than task through", () => {
    expect(delegationRefusal({ name: "ls", args: {} }, [], procedure)).toBeUndefined();
  });

  it("refuses a subagent that does not exist", () => {
    expect(delegationRefusal(task("general-purpose"), [], procedure)).toMatch(
      /no subagent named general-purpose/,
    );
  });

  it("lets Triage run first and refuses it a second time", () => {
    expect(
      delegationRefusal(task("triage"), [new HumanMessage("ticket")], procedure),
    ).toBeUndefined();
    expect(delegationRefusal(task("triage"), afterTriage(question), procedure)).toMatch(
      /already run/,
    );
  });

  it("refuses every Investigator before Triage has run", () => {
    for (const name of investigators) {
      expect(delegationRefusal(task(name), [new HumanMessage("ticket")], procedure)).toMatch(
        /triage subagent first/,
      );
    }
  });

  it("refuses every Investigator when the fast path applies", () => {
    for (const name of investigators) {
      expect(delegationRefusal(task(name), afterTriage(question), procedure)).toMatch(
        /fast path applies/,
      );
    }
  });

  it("lets all three Investigators run below the threshold or for another Category", () => {
    const lowConfidence = { ...question, confidence: 0.5 };
    for (const name of investigators) {
      expect(delegationRefusal(task(name), afterTriage(lowConfidence), procedure)).toBeUndefined();
      expect(delegationRefusal(task(name), afterTriage(dataIssue), procedure)).toBeUndefined();
    }
  });

  it("lets a fan-out of all three through: none of them counts the others, or itself, as already run", () => {
    const messages = fanOut(dataIssue);
    for (const name of investigators) {
      expect(delegationRefusal(task(name, `call-${name}`), messages, procedure)).toBeUndefined();
    }
  });

  it("refuses the second of two calls to the same Investigator in one turn", () => {
    const messages = [
      ...afterTriage(dataIssue),
      new AIMessage({
        content: "",
        tool_calls: [task("log-investigator", "first"), task("log-investigator", "second")],
      }),
    ];

    expect(
      delegationRefusal(task("log-investigator", "first"), messages, procedure),
    ).toBeUndefined();
    expect(delegationRefusal(task("log-investigator", "second"), messages, procedure)).toMatch(
      /log-investigator subagent has already run/,
    );
  });

  it("refuses an Investigator the Resolver already ran in an earlier turn", () => {
    const messages = [
      ...fanOut(dataIssue),
      ...investigators.map(
        (name) => new ToolMessage({ tool_call_id: `call-${name}`, name: "task", content: "{}" }),
      ),
    ];
    expect(delegationRefusal(task("log-investigator", "again"), messages, procedure)).toMatch(
      /log-investigator subagent has already run/,
    );
  });
});

describe("withTriageFocus", () => {
  it("hands each Investigator Triage's hypothesis without letting it skip its own source", () => {
    const focused = withTriageFocus(task("data-investigator"), dataIssue);

    const description = focused.args.description as string;
    expect(description).toContain("do it");
    expect(description).toContain(FOCUS_HEADING);
    expect(description).toContain(dataIssue.hypothesis);
    expect(description).toContain("data_issue");
    expect(description).toMatch(/not a reason to stop/i);
  });

  it("leaves Triage's own brief and unknown subagents alone", () => {
    expect(withTriageFocus(task("triage"), dataIssue)).toEqual(task("triage"));
    expect(withTriageFocus(task("general-purpose"), dataIssue)).toEqual(task("general-purpose"));
  });

  it("leaves the brief alone when there is no Triage to focus with", () => {
    expect(withTriageFocus(task("log-investigator"), undefined)).toEqual(task("log-investigator"));
  });

  it("does not append the hypothesis twice", () => {
    const once = withTriageFocus(task("log-investigator"), dataIssue);
    expect(withTriageFocus(once, dataIssue)).toEqual(once);
  });

  it("still appends when the Resolver's own brief happens to talk about the hypothesis", () => {
    const brief = {
      ...task("log-investigator"),
      args: {
        subagent_type: "log-investigator",
        description: "Investigate. Triage hypothesis: the badge is stale.",
      },
    };

    const description = withTriageFocus(brief, dataIssue).args.description as string;
    expect(description).toContain(FOCUS_HEADING);
    expect(description).toContain(dataIssue.hypothesis);
  });
});

describe("createProcedureGuard", () => {
  const guard = createProcedureGuard(procedure);

  const wrap = (
    toolCall: ReturnType<typeof task>,
    messages: unknown[],
    handler: (request: unknown) => unknown,
  ) =>
    guard.wrapToolCall?.(
      { toolCall, tool: undefined, state: { messages } } as never,
      handler as never,
    );

  it("answers a refused delegation with an error ToolMessage instead of running it", async () => {
    const reply = (await wrap(task("data-investigator", "d1"), afterTriage(question), () => {
      throw new Error("must not run");
    })) as ToolMessage;

    expect(reply.tool_call_id).toBe("d1");
    expect(reply.status).toBe("error");
    expect(reply.content).toMatch(/Refused: the fast path applies/);
  });

  it("hands an allowed delegation to the real handler", async () => {
    const messages = [
      new HumanMessage("ticket"),
      new AIMessage({ content: "", tool_calls: [task("triage", "t1")] }),
    ];
    const ran = new ToolMessage({ tool_call_id: "t1", name: "task", content: "{}" });

    expect(await wrap(task("triage", "t1"), messages, () => ran)).toBe(ran);
  });

  it("focuses an allowed Investigator with the hypothesis before the handler sees it", async () => {
    let seen: string | undefined;
    await wrap(task("incident-historian", "h1"), afterTriage(dataIssue), (request) => {
      seen = (request as { toolCall: { args: { description: string } } }).toolCall.args.description;
      return new ToolMessage({ tool_call_id: "h1", name: "task", content: "{}" });
    });

    expect(seen).toContain(dataIssue.hypothesis);
  });
});

describe("delegating to Code RCA", () => {
  it("is not a subagent at all on a run with no Workspace", () => {
    expect(delegationRefusal(task(CODE_RCA), afterInvestigation(dataIssue), procedure)).toMatch(
      /no subagent named code-rca/,
    );
  });

  it("runs once the three Investigators have reported", () => {
    expect(
      delegationRefusal(task(CODE_RCA), afterInvestigation(dataIssue), withCodeRca),
    ).toBeUndefined();
  });

  it("waits for the Evidence: no Investigator has reported yet", () => {
    expect(delegationRefusal(task(CODE_RCA), afterTriage(dataIssue), withCodeRca)).toMatch(
      /all three Investigators/,
    );
  });

  it("waits for the Evidence: the three were launched but none has answered", () => {
    expect(delegationRefusal(task(CODE_RCA), fanOut(dataIssue), withCodeRca)).toMatch(
      /all three Investigators/,
    );
  });

  it("never runs before Triage, or on the fast path", () => {
    expect(delegationRefusal(task(CODE_RCA), [new HumanMessage("ticket")], withCodeRca)).toMatch(
      /triage subagent first/,
    );
    expect(delegationRefusal(task(CODE_RCA), afterInvestigation(question), withCodeRca)).toMatch(
      /fast path applies/,
    );
  });

  it("runs at most once, like every other subagent", () => {
    const messages = [
      ...afterInvestigation(dataIssue),
      new AIMessage({ content: "", tool_calls: [task(CODE_RCA, "rca")] }),
      new ToolMessage({ tool_call_id: "rca", name: "task", content: "{}" }),
    ];

    expect(delegationRefusal(task(CODE_RCA, "again"), messages, withCodeRca)).toMatch(
      /code-rca subagent has already run/,
    );
  });
});

/** The run as it stands once Code RCA has reported: the patch is in the Workspace. */
function afterCodeRca(triage: Triage) {
  return [
    ...afterInvestigation(triage),
    new AIMessage({ content: "", tool_calls: [task(CODE_RCA, "rca")] }),
    new ToolMessage({ tool_call_id: "rca", name: "task", content: "{}" }),
  ];
}

describe("delegating to the Fix Shipper", () => {
  it("is not a subagent at all on a run with no GitHub server", () => {
    expect(delegationRefusal(task(FIX_SHIPPER), afterCodeRca(dataIssue), withoutGithub)).toMatch(
      /no subagent named fix-shipper/,
    );
  });

  it("pushes once Code RCA has reported", () => {
    expect(
      delegationRefusal(task(FIX_SHIPPER), afterCodeRca(dataIssue), withCodeRca),
    ).toBeUndefined();
  });

  it("waits for the patch: Code RCA has not reported yet", () => {
    expect(
      delegationRefusal(task(FIX_SHIPPER), afterInvestigation(dataIssue), withCodeRca),
    ).toMatch(/wait for Code RCA/);
  });

  it("waits for the patch: Code RCA was launched but has not answered", () => {
    const launched = [
      ...afterInvestigation(dataIssue),
      new AIMessage({ content: "", tool_calls: [task(CODE_RCA, "rca")] }),
    ];
    expect(delegationRefusal(task(FIX_SHIPPER), launched, withCodeRca)).toMatch(
      /wait for Code RCA/,
    );
  });

  it("pushes at most once, like every other subagent", () => {
    const messages = [
      ...afterCodeRca(dataIssue),
      new AIMessage({ content: "", tool_calls: [task(FIX_SHIPPER, "ship")] }),
      new ToolMessage({ tool_call_id: "ship", name: "task", content: "{}" }),
    ];

    expect(delegationRefusal(task(FIX_SHIPPER, "again"), messages, withCodeRca)).toMatch(
      /fix-shipper subagent has already run/,
    );
  });
});
