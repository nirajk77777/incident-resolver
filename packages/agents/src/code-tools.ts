import type { StructuredTool } from "@langchain/core/tools";
import { tool } from "langchain";
import { z } from "zod";
import type { CommandResult, Workspace } from "./workspace";

/**
 * The two fixed tools Code RCA gets on top of its file tools, and the whole of what it can
 * make the Workspace do (ADR-0002). There is no shell: each of these runs one command this
 * repository wrote, with arguments this file fixed, so the honest answer to "what can an agent
 * with code access run here" is the two lines below. A third need is a third named tool.
 */

export const RUN_TESTS = "run_tests";
export const GIT_DIFF_NAMES = "git_diff_names";

/** ShopLite's own unit and storefront suites: pure, and needing no database (PLAN.md section 2). */
const TEST_COMMAND = ["pnpm", ["test"]] as const;
/** Untracked files and all, since the failing test Code RCA writes is a new file. */
const STATUS_COMMAND = ["git", ["status", "--porcelain=v1", "-uall"]] as const;

/**
 * How much of a test run reaches the model. Vitest reports failures and the summary last, so
 * a run that overflows keeps its end: the beginning is the list of files that passed.
 */
export const TEST_OUTPUT_LIMIT = 8_000;

/** One file the patch touched, as `git status` reported it. */
export type ChangedFile = { status: string; path: string };

/** What a porcelain status code means, as a word rather than as git's two letters. */
function describeStatus(code: string): string {
  if (code.startsWith("?")) return "added";
  const letters = code.trim();
  if (letters.includes("R")) return "renamed";
  if (letters.includes("A")) return "added";
  if (letters.includes("D")) return "deleted";
  if (letters.includes("M")) return "modified";
  // Anything else — a conflict, a type change — is still a file the patch touched, and the
  // list is read as prose, so it says so rather than handing back a two-letter code.
  return "changed";
}

/**
 * Git quotes a path with a space or an unusual character in it; the quotes are not the name.
 * Its escapes are C-style rather than JSON's, so a path with an octal escape in it is left as
 * git printed it: an odd-looking path in the list is better than a tool that throws on one.
 */
function unquote(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"')) return path;
  try {
    return JSON.parse(path) as string;
  } catch {
    return path.slice(1, -1);
  }
}

/** The files a Workspace's working tree differs from its clone by, newest state first. */
export function changedFilesOf(stdout: string): ChangedFile[] {
  return stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const code = line.slice(0, 2);
      const rest = line.slice(3).trim();
      // A rename reports both names; the one that matters is where the code lives now.
      const renamedTo = rest.split(" -> ").at(-1) ?? rest;
      return { status: describeStatus(code), path: unquote(renamedTo) };
    });
}

export function formatChangedFiles(files: ChangedFile[]): string {
  if (files.length === 0) {
    return "No files have changed in the Workspace yet: nothing has been written or patched.";
  }
  const lines = files.map((file) => `- ${file.status}: ${file.path}`);
  return [`${files.length} file(s) changed in the Workspace:`, ...lines].join("\n");
}

/** The end of a command's output, with what was cut named rather than silently dropped. */
function tail(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `… (${text.length - limit} earlier characters omitted)\n${text.slice(-limit)}`;
}

/**
 * What the test run tells Code RCA. A failing suite is a result, not an error: writing a test
 * that fails is the first thing Code RCA is asked to do, so a red run has to come back as
 * something to read rather than as a tool that broke.
 */
export function formatTestRun({ exitCode, stdout, stderr }: CommandResult): string {
  const output = [stdout, stderr].filter((text) => text.trim().length > 0).join("\n");
  const headline =
    exitCode === 0
      ? "The ShopLite test suite passed: every test is green."
      : `The ShopLite test suite failed (exit code ${exitCode}). The failures are below.`;
  return `${headline}\n\n${tail(output, TEST_OUTPUT_LIMIT)}`;
}

const noArgs = z.object({});

/** Runs ShopLite's suite in one Ticket's Workspace. Code RCA's, and nobody else's. */
export function createRunTestsTool(workspace: Workspace): StructuredTool {
  return tool(async () => formatTestRun(await workspace.run(...TEST_COMMAND)), {
    name: RUN_TESTS,
    description:
      "Runs ShopLite's whole test suite in your Workspace and returns what it printed. " +
      "Use it to watch the test you wrote fail before you patch anything, and to prove the " +
      "suite is green after. It takes no arguments and always runs every test.",
    schema: noArgs,
  });
}

/**
 * Lists what the Workspace's working tree differs by. Code RCA reads it to check its own
 * patch; the Fix Shipper reads it to know which files to push, which is why it is a tool of
 * its own rather than half of a pair.
 */
export function createGitDiffNamesTool(workspace: Workspace): StructuredTool {
  return tool(
    async () => formatChangedFiles(changedFilesOf((await workspace.run(...STATUS_COMMAND)).stdout)),
    {
      name: GIT_DIFF_NAMES,
      description:
        "Lists the files you have changed in the Workspace, new files included, and what " +
        "happened to each. Use it to check the patch is the change you meant to make and " +
        "nothing else. It takes no arguments.",
      schema: noArgs,
    },
  );
}

/** The two tools, bound to one Ticket's Workspace, which they clone on first use. */
export function createCodeTools(workspace: Workspace): StructuredTool[] {
  return [createRunTestsTool(workspace), createGitDiffNamesTool(workspace)];
}
