import { describe, expect, it } from "vitest";
import {
  changedFilesOf,
  createCodeTools,
  formatChangedFiles,
  formatTestRun,
  GIT_DIFF_NAMES,
  RUN_TESTS,
  TEST_OUTPUT_LIMIT,
} from "./code-tools";
import type { CommandResult, Workspace } from "./workspace";

const green: CommandResult = {
  exitCode: 0,
  stdout: "Test Files  12 passed (12)\n     Tests  47 passed (47)",
  stderr: "",
};

const red: CommandResult = {
  exitCode: 1,
  stdout: "FAIL apps/api/src/domain/order.test.ts\nexpected 4499 to be 4999",
  stderr: "",
};

/** A Workspace that records what was run and answers with whatever the test set up. */
function fakeWorkspace(result: CommandResult = green) {
  const calls: { command: string; args: string[] }[] = [];
  const workspace: Workspace = {
    ticketId: "ticket-1",
    dir: "/workspaces/ticket-1",
    ready: async () => {},
    run: async (command, args) => {
      calls.push({ command, args: [...args] });
      return result;
    },
  };
  return { calls, workspace };
}

const toolsByName = (workspace: Workspace) =>
  new Map(createCodeTools(workspace).map((tool) => [tool.name, tool]));

describe("createCodeTools", () => {
  it("gives Code RCA the two named tools and nothing else", () => {
    expect(createCodeTools(fakeWorkspace().workspace).map((tool) => tool.name)).toEqual([
      RUN_TESTS,
      GIT_DIFF_NAMES,
    ]);
  });

  it("runs ShopLite's own test suite inside the Workspace", async () => {
    const { calls, workspace } = fakeWorkspace();

    const answer = await toolsByName(workspace).get(RUN_TESTS)?.invoke({});

    expect(calls).toEqual([{ command: "pnpm", args: ["test"] }]);
    expect(answer).toContain("passed");
  });

  it("lists the files the patch changed, new files included", async () => {
    const status = {
      exitCode: 0,
      stdout: "?? apps/api/src/domain/order.regression.test.ts\n",
      stderr: "",
    };
    const { calls, workspace } = fakeWorkspace(status);

    const answer = await toolsByName(workspace).get(GIT_DIFF_NAMES)?.invoke({});

    expect(calls).toEqual([{ command: "git", args: ["status", "--porcelain=v1", "-uall"] }]);
    expect(answer).toContain("apps/api/src/domain/order.regression.test.ts");
  });
});

describe("formatTestRun", () => {
  it("says the suite passed so the agent can claim tests green", () => {
    expect(formatTestRun(green)).toContain("passed");
    expect(formatTestRun(green)).toContain("47 passed (47)");
  });

  it("says the suite failed and keeps the failure to read", () => {
    const reported = formatTestRun(red);

    expect(reported).toContain("failed");
    expect(reported).toContain("expected 4499 to be 4999");
  });

  it("keeps the end of a long run, where the failures are reported", () => {
    const tail = "expected 4499 to be 4999";
    const reported = formatTestRun({
      exitCode: 1,
      stdout: `${"noise\n".repeat(TEST_OUTPUT_LIMIT)}${tail}`,
      stderr: "",
    });

    expect(reported).toContain(tail);
    expect(reported.length).toBeLessThan(TEST_OUTPUT_LIMIT + 500);
  });
});

describe("changedFilesOf", () => {
  it("reads git's porcelain status, naming what happened to each file", () => {
    const stdout = [
      " M apps/api/src/domain/order.ts",
      "?? apps/api/src/domain/order.regression.test.ts",
      " D apps/api/src/domain/dead.ts",
      "R  apps/api/src/old.ts -> apps/api/src/new.ts",
      "",
    ].join("\n");

    expect(changedFilesOf(stdout)).toEqual([
      { status: "modified", path: "apps/api/src/domain/order.ts" },
      { status: "added", path: "apps/api/src/domain/order.regression.test.ts" },
      { status: "deleted", path: "apps/api/src/domain/dead.ts" },
      { status: "renamed", path: "apps/api/src/new.ts" },
    ]);
  });

  it("still names a status it does not recognise as a change", () => {
    expect(changedFilesOf("UU apps/api/src/conflicted.ts")).toEqual([
      { status: "changed", path: "apps/api/src/conflicted.ts" },
    ]);
  });

  it("unquotes a path git escaped", () => {
    expect(changedFilesOf('?? "apps/api/src/a b.ts"')).toEqual([
      { status: "added", path: "apps/api/src/a b.ts" },
    ]);
  });
});

describe("formatChangedFiles", () => {
  it("says so plainly when the Workspace is untouched", () => {
    expect(formatChangedFiles([])).toMatch(/no files/i);
  });
});

describe("a path git escaped in a way JSON cannot read", () => {
  it("comes back without its quotes rather than throwing", () => {
    expect(changedFilesOf('?? "apps/api/src/caf\\303\\251.ts"')).toEqual([
      { status: "added", path: "apps/api/src/caf\\303\\251.ts" },
    ]);
  });
});
