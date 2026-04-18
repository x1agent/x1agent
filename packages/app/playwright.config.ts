import { defineConfig, devices } from "@playwright/test";

const API_URL = process.env.API_PUBLIC_URL || "http://localhost:30001";
const APP_URL = process.env.PUBLIC_URL || "http://localhost:4322";

/**
 * Playwright config for x1agent e2e.
 *
 * Assumptions:
 *   - Postgres is reachable at DATABASE_URL (port-forwarded from OrbStack
 *     locally; a `services.postgres` container in CI).
 *   - AUTH_BYPASS=true is set so the dev button is active.
 *
 * The api + app dev servers are started by `webServer` below. In CI they
 * get the same env the local `mise run dev:*` tasks use.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  reporter: process.env.CI ? "github" : "list",
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: APP_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    ignoreHTTPSErrors: true,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command: "bun run --cwd ../api dev",
      url: `${API_URL}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: "astro dev --port 4322 --host 0.0.0.0",
      url: APP_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
