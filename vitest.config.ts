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
          testTimeout: 30_000,
          hookTimeout: 60_000,
          // Every integration file drives the same Postgres, and the demo reset clears it,
          // so running two at once has one file emptying tables another is mid-run against.
          fileParallelism: false,
        },
      },
    ],
  },
});
