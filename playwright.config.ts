/// <reference types="node" />

import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.TELEVECHA_E2E_PORT ?? 4174);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: 0,
  reporter: 'line',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'desktop-chromium',
      testIgnore: /\.mobile\.spec\.ts/u,
      use: devices['Desktop Chrome'],
    },
    {
      name: 'mobile-chromium',
      testMatch: /\.mobile\.spec\.ts/u,
      use: devices['Pixel 5'],
    },
  ],
  webServer: {
    command: `npm run dev:e2e -- ${port}`,
    url: baseURL,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
