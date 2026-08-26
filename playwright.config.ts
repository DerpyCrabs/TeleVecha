import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: 0,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:4173',
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
    command: 'VITE_TELEVECHA_E2E=1 npm run dev -- --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
