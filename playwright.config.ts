import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  timeout: 90000,
  expect: { timeout: 15000 },
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:3100", viewport: { width: 1440, height: 1050 }, actionTimeout: 15000, navigationTimeout: 45000, screenshot: "only-on-failure", trace: "retain-on-failure" },
  webServer: {
    command: "npm run dev -- --port 3100",
    url: "http://127.0.0.1:3100",
    reuseExistingServer: false,
    timeout: 120000,
    env: { ADMITFLOW_DB: process.env.ADMITFLOW_BROWSER_DB || ".data/browser-tests.sqlite" },
  },
});
