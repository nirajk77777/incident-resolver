import { configDefaults, defineConfig } from "vitest/config";

// Tests are tagged by file name.
//   *.test.ts             unit tests, no Docker needed:   pnpm test
//   *.integration.test.ts need `docker compose up`:       pnpm test:integration
const integrationGlob = "**/*.integration.test.ts";
// Worktrees under .claude/ carry their own copy of every test; never run those from here.
const worktreesGlob = "**/.claude/**";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["**/*.test.ts"],
          exclude: [...configDefaults.exclude, integrationGlob, worktreesGlob],
        },
      },
      {
        test: {
          name: "integration",
          include: [integrationGlob],
          exclude: [...configDefaults.exclude, worktreesGlob],
          // One file at a time. These share one Postgres and one Cohere key, whose trial tier
          // allows ten calls a minute; running the suites at once spends that in one burst.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
