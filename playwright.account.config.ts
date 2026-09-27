import { defineConfig } from "@playwright/test";

if (process.env.ADMITFLOW_BROWSER_ISOLATED !== "1" || !process.env.ADMITFLOW_BROWSER_DB || process.env.DATABASE_URL || process.env.DATABASE_URL_UNPOOLED) {
  throw new Error("Run account flow tests through npm run verify:browser with isolated fixtures.");
}

export default defineConfig({
  testDir: "./tests/account-browser",
  fullyParallel: false,
  workers: 1,
  timeout: 90000,
  expect: { timeout: 15000 },
  reporter: "list",
  outputDir: "test-results/account-flow",
  use: {
    baseURL: "http://127.0.0.1:3101", viewport: { width: 1440, height: 1000 },
    actionTimeout: 15000, navigationTimeout: 45000, screenshot: "only-on-failure", trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev -- --port 3101",
    url: "http://127.0.0.1:3101/signup",
    reuseExistingServer: false,
    timeout: 240000,
    stdout: "pipe",
    env: {
      // Exercise real Next server actions and AuthKit PKCE creation without usable provider/database credentials.
      // Organization responses and the outbound authorization navigation are intercepted by each test.
      DATABASE_URL: "postgresql://fixture:fixture@127.0.0.1:1/account_flow_fixture",
      DATABASE_URL_UNPOOLED: "",
      ADMITFLOW_DB: process.env.ADMITFLOW_BROWSER_DB,
      APP_BASE_URL: "http://127.0.0.1:3101",
      WORKOS_API_KEY: "sk_test_account_fixture_not_a_real_key",
      WORKOS_CLIENT_ID: "client_account_fixture",
      WORKOS_COOKIE_PASSWORD: "account-flow-fixture-cookie-password-not-for-production",
      NEXT_PUBLIC_WORKOS_REDIRECT_URI: "http://127.0.0.1:3101/callback",
      WORKOS_CLAIM_TOKEN: "",
      WORKOS_API_HOSTNAME: "api.workos.com",
      WORKOS_API_PORT: "443",
      WORKOS_API_HTTPS: "true",
      WORKOS_COOKIE_DOMAIN: "",
      WORKOS_COOKIE_NAME: "wos-session",
      WORKOS_COOKIE_SAMESITE: "lax",
    },
  },
});
