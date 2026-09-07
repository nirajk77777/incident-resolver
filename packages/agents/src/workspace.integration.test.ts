import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfig } from "@incident-resolver/shared/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCodeTools, GIT_DIFF_NAMES, RUN_TESTS } from "./code-tools";
import { createWorkspaceStore, type Workspace } from "./workspace";
import { WORKSPACE_ROUTE, workspaceBackend } from "./workspace-mount";

/**
 * The Workspace against the real ShopLite repository: a clone, an install, and the two tools
 * Code RCA has. It walks the double-discount bug the way Code RCA is asked to — see the suite
 * green, write a test that fails, patch the domain module, see it green again — so what is
 * proven here is that the seam works and the planted bug is reachable through it, without
 * spending a model run on it.
 *
 * Needs the network and a pnpm store. Cloning and installing takes a minute or two.
 */

const config = getConfig();
/** Cloning and installing ShopLite is the slow part, and it is capped by the same setting. */
const CLONE_TIMEOUT_MS = config.workspace.commandTimeoutMs;

/** The file the double-discount bug is in, and the line the patch is on. */
const ORDER = `${WORKSPACE_ROUTE}/apps/api/src/domain/order.ts`;
const ORDER_TEST = `${WORKSPACE_ROUTE}/apps/api/src/domain/order.test.ts`;

/** What `finalizeOrder` does wrong: it prices from a subtotal that is already discounted. */
const DOUBLE_DISCOUNT = "const subtotalCents = calculateSubtotal(snapshot, discount);";
const SINGLE_DISCOUNT = "const subtotalCents = calculateSubtotal(snapshot);";

/**
 * Two mugs at £12.00 and a candle at £18.00 come to £42.00; SALE10 takes £4.20 off it, once.
 * The numbers are the Reporter's, from the double-discount Ticket.
 */
const SINGLE_DISCOUNT_TEST = `
describe("finalizeOrder and a percentage code", () => {
  it("takes the code off exactly once", () => {
    const mugs: CartLine = { productId: "mug", unitPriceCents: 1200, quantity: 2 };
    const candle: CartLine = { productId: "candle", unitPriceCents: 1800, quantity: 1 };
    const sale10 = {
      code: "SALE10",
      kind: "percent" as const,
      value: 10,
      minSubtotalCents: 0,
      active: true,
    };

    const order = finalizeOrder([mugs, candle], sale10);

    expect(order.subtotalCents).toBe(4200);
    expect(order.discountCents).toBe(420);
    expect(order.totalCents).toBe(3780);
  });
});
`;

let root: string;
let workspace: Workspace;
let backend: ReturnType<typeof workspaceBackend>;
let tools: Map<string, { invoke(args: Record<string, never>): Promise<unknown> }>;

const runTests = () => tools.get(RUN_TESTS)?.invoke({}) as Promise<string>;
const changedFiles = () => tools.get(GIT_DIFF_NAMES)?.invoke({}) as Promise<string>;

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "workspaces-integration-")));
  // The store is built by hand rather than with `workspaceStoreFor` so the clones land in a
  // temp directory this test owns and cleans up, not in the repository's own `workspaces/`.
  const store = createWorkspaceStore({
    root,
    repoUrl: config.workspace.repoUrl,
    timeoutMs: CLONE_TIMEOUT_MS,
  });
  workspace = store.for("50000000-0000-4000-8000-000000000004");
  await workspace.ready();
  backend = workspaceBackend(workspace);
  tools = new Map(
    createCodeTools(workspace).map((tool) => [
      tool.name,
      tool as unknown as { invoke(args: Record<string, never>): Promise<unknown> },
    ]),
  );
}, CLONE_TIMEOUT_MS);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("a Workspace cloned from ShopLite", () => {
  it(
    "is green before anything is changed, and reports no changed files",
    async () => {
      expect(await runTests()).toContain("passed");
      expect(await changedFiles()).toMatch(/no files/i);
    },
    CLONE_TIMEOUT_MS,
  );

  it("rejects a read that climbs out of it", async () => {
    const escaped = await backend
      .read(`${WORKSPACE_ROUTE}/../../../etc/passwd`)
      .catch((error: unknown) => ({ error: String(error), content: undefined }));

    expect(escaped.error).toBeDefined();
    expect(escaped.content).toBeUndefined();
  });

  it(
    "goes red on a test asserting the discount comes off once, and green on the patch",
    async () => {
      const before = await backend.read(ORDER_TEST);
      expect(before.error).toBeUndefined();
      await backend.write(ORDER_TEST, `${String(before.content)}${SINGLE_DISCOUNT_TEST}`);

      const red = await runTests();
      expect(red).toContain("failed");
      expect(red).toContain("4200");

      const patched = await backend.edit(ORDER, DOUBLE_DISCOUNT, SINGLE_DISCOUNT);
      expect(patched.error).toBeUndefined();

      expect(await runTests()).toContain("passed");
      const changed = await changedFiles();
      expect(changed).toContain("apps/api/src/domain/order.ts");
      expect(changed).toContain("apps/api/src/domain/order.test.ts");
    },
    CLONE_TIMEOUT_MS,
  );
});
