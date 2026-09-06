import { getConfig } from "@incident-resolver/shared/config";
import { workspaceStoreFor, workspacesRoot } from "../src/workspace";

/**
 * Removes every per-Ticket Workspace, leaving the Workspaces root itself and anything in it
 * that is not a Workspace. `pnpm workspaces:clean` runs it; the demo reset, which also clears
 * Tickets, events and approvals, will call the same store, since a reset that left the clones
 * behind would leave a rerun of the same Ticket reading last time's patch.
 */
const config = getConfig();
await workspaceStoreFor(config).removeAll();
console.log(`Removed every Workspace under ${workspacesRoot(config.workspace.dir)}`);
