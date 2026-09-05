import { configDefaults, defineConfig } from "vitest/config";

// Tests are tagged by file name.
//   *.test.ts             unit tests, no Docker needed:   pnpm test
//   *.integration.test.ts need `docker compose up`:       pnpm test:integration
const integrationGlob = "**/*.integration.test.ts";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["**/*.test.ts"],
          exclude: [...configDefaults.exclude, integrationGlob],
        },
      },
      {
        test: {
          name: "integration",
          include: [integrationGlob],
          exclude: [...configDefaults.exclude],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
