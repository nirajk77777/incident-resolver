import {
  CompositeBackend,
  FilesystemBackend,
  type FilesystemPermission,
  StateBackend,
} from "deepagents";
import type { Workspace } from "./workspace";

/**
 * Where the Ticket's Workspace sits on the agent's filesystem, and who may reach it.
 *
 * Two subagents see the clone and neither can get out of it. Code RCA reads and writes it:
 * it patches the defect and runs the suite. The Fix Shipper only reads it, because what it
 * pushes to GitHub has to be what Code RCA left behind and nothing it added on the way. The
 * Resolver and every other subagent are shut out entirely, so the one agent that can change
 * ShopLite's code is the one whose job it is (ADR-0002).
 *
 * The confinement is configuration rather than prompt: the mount is a `FilesystemBackend` in
 * virtual mode, so a path that climbs out of the clone is rejected before it reaches the disk,
 * and the rules below are what the deep agent enforces on every file tool call.
 */

/** Where the Workspace is mounted in the agent's view of the filesystem. */
export const WORKSPACE_ROUTE = "/workspace";

/**
 * The same mount as CompositeBackend wants it registered. The trailing slash is load-bearing:
 * the composite strips the route by length and prefixes a slash back, so a route without one
 * hands the Workspace's backend a doubled `//path` that no file matches.
 */
const WORKSPACE_MOUNT = `${WORKSPACE_ROUTE}/`;

const workspacePaths = [WORKSPACE_ROUTE, `${WORKSPACE_ROUTE}/**`];

/**
 * The agent's filesystem: the Workspace at its route, everything else in graph state as before.
 *
 * Routing rather than rooting the whole agent at the clone is what keeps the agent's own
 * scratch files — the large tool results the filesystem middleware evicts — out of ShopLite's
 * working tree, where `git_diff_names` would report them as part of the patch.
 *
 * Note the composite supports no `execute`, so the filesystem middleware drops its shell tool:
 * there is no command in this agent that this repository did not write.
 */
export function workspaceBackend(workspace: Workspace): CompositeBackend {
  return new CompositeBackend(new StateBackend(), {
    [WORKSPACE_MOUNT]: new FilesystemBackend({ rootDir: workspace.dir, virtualMode: true }),
  });
}

/** The Resolver's rule and every subagent's that does not override it: the Workspace is closed. */
export const workspaceClosed: FilesystemPermission[] = [
  { operations: ["read", "write"], paths: workspacePaths, mode: "deny" },
];

/** Code RCA's rule: it is the only agent that may change ShopLite's source. */
export const workspaceWritable: FilesystemPermission[] = [
  { operations: ["read", "write"], paths: workspacePaths, mode: "allow" },
];

/**
 * The Fix Shipper's rule: it reads the patch in order to push it, and writes nothing. A file
 * it could edit here would be a change on the branch that no test in the Workspace ever ran.
 */
export const workspaceReadable: FilesystemPermission[] = [
  { operations: ["read"], paths: workspacePaths, mode: "allow" },
  { operations: ["write"], paths: workspacePaths, mode: "deny" },
];
