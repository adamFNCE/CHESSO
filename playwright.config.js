const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: 0,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry'
  },
  webServer: [
    {
      command: 'npm run start --workspace @chesso/server',
      port: 8080,
      reuseExistingServer: true,
      timeout: 120_000
    },
    {
      command: 'npm run dev --workspace @chesso/web -- --host 127.0.0.1 --port 4173',
      port: 4173,
      reuseExistingServer: true,
      timeout: 120_000
    }
  ]
});
