import { defineConfig, devices } from '@playwright/test';
const external = process.env.JOT_TEST_URL;
export default defineConfig({
  testDir: './tests/browser',
  outputDir: process.env.JOT_TEST_OUTPUT || 'test-results',
  timeout: 45000,
  expect: { timeout: 12000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: external || 'http://localhost:3101',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: external
    ? undefined
    : {
        command: 'node --import tsx tests/browser-server.ts',
        url: 'http://localhost:3101/api/health',
        reuseExistingServer: false,
      },
});
