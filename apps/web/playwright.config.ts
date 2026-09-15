import { defineConfig, devices } from "@playwright/test";

/**
 * E2E stack: local Supabase (docker) + relay worker in SIMULATE mode + next dev.
 * Run `pnpm test:e2e` — it prepares env files and seeds the database first.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 2 : 0,
  workers: 1, // specs share one database — keep them serial
  // Artifacts live outside the package so ESLint/Next never scan the
  // bundled viewer JS that Playwright emits into its reports.
  outputDir: "../../.playwright/test-results",
  reporter: [["list"], ["html", { open: "never", outputFolder: "../../.playwright/report" }]],
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "node ../../scripts/e2e-launch.mjs worker",
      url: "http://127.0.0.1:8788/health",
      timeout: 90_000,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: "node ../../scripts/e2e-launch.mjs web",
      url: "http://127.0.0.1:3100/login",
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
