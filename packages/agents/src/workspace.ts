import { mkdirSync, realpathSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "@incident-resolver/shared";
import { execa } from "execa";

/**
 * A Workspace is a per-Ticket clone of the ShopLite repository where Code RCA reads, edits,
 * and runs tests (CONTEXT.md). One Ticket, one clone: the agent never edits a shared clone,
 * and the patch it leaves behind belongs to exactly one Ticket.
 *
 * Cloning is deferred until something asks for it, which in a run is the Resolver's first
 * delegation to Code RCA. Most Tickets are answered or fixed in data and never look at the
 * code, and a clone and an install they will not use is a minute of a Reporter's wait.
 */

/** What one command left behind. A non-zero exit is a result, not a throw: callers read it. */
export type CommandResult = { exitCode: number; stdout: string; stderr: string };

/**
 * How a Workspace runs a command. Injected so the Workspace can be tested without a network
 * and a package manager, and so the only implementation that spawns anything is `execaRunner`.
 */
export type RunCommand = (
  command: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs: number },
) => Promise<CommandResult>;

export type Workspace = {
  ticketId: string;
  /** Where the clone lives. The directory exists once `ready` has resolved. */
  dir: string;
  /** Clones ShopLite and installs its dependencies. Does the work once, however often it is called. */
  ready(): Promise<void>;
  /** Runs one of the fixed commands inside the Workspace, cloning it first if it is not there yet. */
  run(command: string, args: readonly string[]): Promise<CommandResult>;
};

export type WorkspaceStore = {
  /** The Workspace for one Ticket. Nothing is cloned until it is made ready. */
  for(ticketId: string): Workspace;
  /**
   * Removes every Workspace, leaving the root itself empty and ready to clone into again.
   * This is what a demo reset calls, alongside clearing Tickets, events, and approvals.
   */
  removeAll(): Promise<void>;
};

export type WorkspaceStoreOptions = {
  /** The directory the per-Ticket clones sit in. */
  root: string;
  /** The ShopLite repository to clone, from config. */
  repoUrl: string;
  run?: RunCommand;
  /** How long any one command may take: a clone, an install, or a test run. */
  timeoutMs?: number;
  /** Progress for whoever runs the portal, never for the Reporter. */
  log?: (line: string) => void;
};

/** A shallow clone: the agent reads and patches the working tree, and never needs the history. */
const CLONE_ARGS = ["clone", "--depth", "1"] as const;
/**
 * ShopLite's tests are pure and need no database, but they do need its dev dependencies, and a
 * clone arrives without them. The lockfile is honoured so a Workspace runs the versions ShopLite
 * is pinned to rather than whatever resolves today.
 */
const INSTALL_ARGS = ["install", "--frozen-lockfile"] as const;

const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * Where one Ticket's Workspace lives. The Ticket id has to name exactly one directory directly
 * under the root: a portal Ticket id is a uuid, so anything else arrived from somewhere it
 * should not have, and a clone made outside the root is one `removeAll` would leave behind.
 */
export function workspaceDirFor(root: string, ticketId: string): string {
  const dir = resolve(root, ticketId);
  const within = resolve(root) + sep;
  if (!dir.startsWith(within) || dir.slice(within.length).includes(sep)) {
    throw new Error(`Ticket id ${ticketId} does not name a Workspace under ${root}`);
  }
  return dir;
}

/** This repository's root, so a relative `WORKSPACES_DIR` means the same from any package. */
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

/** The configured Workspaces directory as an absolute path. */
export function workspacesRoot(configured: string): string {
  return isAbsolute(configured) ? configured : resolve(repoRoot, configured);
}

/**
 * The root as the filesystem itself names it, with the directory made if it was not there.
 *
 * Resolving the symlinks matters: the file tools confine Code RCA by comparing a resolved path
 * against the Workspace root, and a root reached through a symlink — `/tmp` and `/var` on
 * macOS are — would fail that comparison for every file in the clone.
 */
function realRoot(root: string): string {
  try {
    mkdirSync(root, { recursive: true });
    return realpathSync(root);
  } catch {
    return resolve(root);
  }
}

/** Runs a command as a child process, reporting a failure as a result rather than throwing. */
export const execaRunner: RunCommand = async (command, args, { cwd, timeoutMs }) => {
  const result = await execa(command, [...args], {
    cwd,
    timeout: timeoutMs,
    reject: false,
    all: false,
  });
  const timedOut = result.timedOut ? `\nThe command was stopped after ${timeoutMs}ms.` : "";
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout ?? "",
    stderr: `${result.stderr ?? ""}${timedOut}`,
  };
};

/**
 * The store as every caller in this repository wants it: the portal, the command line, and the
 * clean script all read the same three settings, and a fourth caller reading two of them by
 * hand is how a Workspace ends up cloned somewhere a reset does not look.
 */
export function workspaceStoreFor(
  config: Pick<Config, "workspace">,
  log?: (line: string) => void,
): WorkspaceStore {
  return createWorkspaceStore({
    root: workspacesRoot(config.workspace.dir),
    repoUrl: config.workspace.repoUrl,
    timeoutMs: config.workspace.commandTimeoutMs,
    log,
  });
}

export function createWorkspaceStore({
  root: configuredRoot,
  repoUrl,
  run = execaRunner,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  log = () => {},
}: WorkspaceStoreOptions): WorkspaceStore {
  const root = realRoot(configuredRoot);

  function workspaceFor(ticketId: string): Workspace {
    const dir = workspaceDirFor(root, ticketId);
    let cloned: Promise<void> | undefined;

    async function clone(): Promise<void> {
      // Anything left from an earlier run of the same Ticket goes first: a re-run investigates
      // the code as it is on the default branch, not on top of the patch the last run wrote.
      await rm(dir, { recursive: true, force: true });
      await mkdir(root, { recursive: true });
      log(`Cloning ${repoUrl} into ${dir}`);
      orThrow(await run("git", [...CLONE_ARGS, repoUrl, dir], { cwd: root, timeoutMs }), "clone");
      orThrow(await run("pnpm", [...INSTALL_ARGS], { cwd: dir, timeoutMs }), "install");
    }

    function orThrow(result: CommandResult, what: string): void {
      if (result.exitCode === 0) return;
      const reason = [result.stderr, result.stdout].find((text) => text.trim().length > 0) ?? "";
      throw new Error(
        `Could not ${what} the Workspace for Ticket ${ticketId} (exit code ${result.exitCode}): ${reason.trim()}`,
      );
    }

    function ready(): Promise<void> {
      // A clone that failed is not remembered: the next delegation tries again rather than
      // reporting an error nobody can act on from a Workspace that was never made.
      cloned ??= clone().catch((error: unknown) => {
        cloned = undefined;
        throw error;
      });
      return cloned;
    }

    return {
      ticketId,
      dir,
      ready,
      async run(command, args) {
        await ready();
        return run(command, args, { cwd: dir, timeoutMs });
      },
    };
  }

  return {
    for: workspaceFor,
    async removeAll() {
      await mkdir(root, { recursive: true });
      // Every Workspace is a directory directly under the root, so those are what go. The root
      // itself is left standing, and so is anything in it that is not a Workspace: WORKSPACES_DIR
      // can be pointed anywhere, and a reset must not take a directory's other contents with it.
      const entries = await readdir(root, { withFileTypes: true });
      await Promise.all(
        entries
          .filter((entry) => entry.isDirectory())
          .map((entry) => rm(resolve(root, entry.name), { recursive: true, force: true })),
      );
    },
  };
}
