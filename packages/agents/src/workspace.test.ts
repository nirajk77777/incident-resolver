import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CommandResult,
  createWorkspaceStore,
  type RunCommand,
  workspaceDirFor,
} from "./workspace";

const ok: CommandResult = { exitCode: 0, stdout: "", stderr: "" };

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  // Realpath because macOS reaches its temp directory through a symlink, and the store
  // reports the root as the filesystem names it.
  const root = await realpath(await mkdtemp(join(tmpdir(), "workspaces-")));
  roots.push(root);
  return root;
}

/** Records what was run and creates the clone directory the way `git clone` would. */
function recorder(results: Partial<Record<string, CommandResult>> = {}) {
  const calls: { command: string; args: string[]; cwd: string }[] = [];
  const run: RunCommand = async (command, args, options) => {
    calls.push({ command, args: [...args], cwd: options.cwd });
    return results[command] ?? ok;
  };
  return { calls, run };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("createWorkspaceStore", () => {
  it("clones ShopLite into the Ticket's own directory and installs its dependencies", async () => {
    const root = await tempRoot();
    const { calls, run } = recorder();
    const store = createWorkspaceStore({ root, repoUrl: "git@host:shoplite.git", run });

    const workspace = store.for("ticket-1");
    await workspace.ready();

    expect(workspace.dir).toBe(join(root, "ticket-1"));
    expect(calls).toEqual([
      {
        command: "git",
        args: ["clone", "--depth", "1", "git@host:shoplite.git", workspace.dir],
        cwd: root,
      },
      { command: "pnpm", args: ["install", "--frozen-lockfile"], cwd: workspace.dir },
    ]);
  });

  it("clones once however often the Workspace is asked for", async () => {
    const root = await tempRoot();
    const { calls, run } = recorder();
    const workspace = createWorkspaceStore({ root, repoUrl: "repo", run }).for("ticket-1");

    await Promise.all([workspace.ready(), workspace.ready()]);
    await workspace.ready();

    expect(calls.filter((call) => call.command === "git")).toHaveLength(1);
  });

  it("says which command failed rather than leaving a half-made Workspace", async () => {
    const root = await tempRoot();
    const { run } = recorder({
      pnpm: { exitCode: 1, stdout: "", stderr: "ERR_PNPM_OUTDATED_LOCKFILE" },
    });
    const workspace = createWorkspaceStore({ root, repoUrl: "repo", run }).for("ticket-1");

    await expect(workspace.ready()).rejects.toThrow(/ERR_PNPM_OUTDATED_LOCKFILE/);
  });

  it("removes every Workspace on reset, and nothing else under the root", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "ticket-1", "apps"), { recursive: true });
    await mkdir(join(root, "ticket-2"), { recursive: true });
    // WORKSPACES_DIR can be pointed at a directory that holds other things.
    await writeFile(join(root, "notes.txt"), "not a Workspace");
    const store = createWorkspaceStore({ root, repoUrl: "repo", run: recorder().run });

    await store.removeAll();

    expect(await readdir(root)).toEqual(["notes.txt"]);
  });
});

describe("workspaceDirFor", () => {
  it("puts a Ticket's Workspace under the root", () => {
    expect(workspaceDirFor("/tmp/workspaces", "ticket-1")).toBe("/tmp/workspaces/ticket-1");
  });

  it("refuses a Ticket id that would climb out of the root", () => {
    expect(() => workspaceDirFor("/tmp/workspaces", "../etc")).toThrow(/\.\.\/etc/);
  });
});

describe("a Ticket id that is not one directory name", () => {
  it("is refused rather than cloned outside the root a reset would clear", () => {
    expect(() => workspaceDirFor("/tmp/workspaces", "nested/ticket")).toThrow(/nested\/ticket/);
    expect(() => workspaceDirFor("/tmp/workspaces", "")).toThrow();
  });
});
