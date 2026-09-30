/// <reference types="node" />

import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.TELEVECHA_E2E_PORT ?? 4174);
const devPort = port + 1;
const baseURL = `http://127.0.0.1:${port}`;
const devURL = `http://127.0.0.1:${devPort}`;
const bundle = 'node_modules/.cache/televecha-e2e';
const desktop = devices['Desktop Chrome'];

export default defineConfig({
  testDir: './e2e',
  // Every test has its own browser context, and with it its own IndexedDB, locks and
  // broadcast channels, so tests only share the two servers.
  fullyParallel: true,
  workers: process.env.TELEVECHA_E2E_WORKERS ? Number(process.env.TELEVECHA_E2E_WORKERS) : 6,
  retries: 0,
  reporter: 'line',
  // Recording a trace for every test costs about a fifth of the run. A failure keeps its
  // screenshot and error context; rerun it with TELEVECHA_E2E_TRACE=1 for the full trace.
  use: {
    baseURL,
    trace: process.env.TELEVECHA_E2E_TRACE ? 'retain-on-failure' : 'off',
    screenshot: 'only-on-failure',
  },
  projects: [
    // Every test starts the application in a fresh browser context. The bundle starts in a
    // quarter of the time the development server needs to serve its unbundled modules.
    { name: 'desktop-chromium', testIgnore: /\.(mobile|dev)\.spec\.ts/u, use: desktop },
    { name: 'mobile-chromium', testMatch: /\.mobile\.spec\.ts/u, use: devices['Pixel 5'] },
    // Specs that import source modules or exercise the development server itself.
    { name: 'dev-chromium', testMatch: /\.dev\.spec\.ts/u, use: { ...desktop, baseURL: devURL } },
  ],
  webServer: [
    {
      command: `VITE_TELEVECHA_E2E=1 npx vp build --outDir ${bundle} --emptyOutDir && npx vp preview --outDir ${bundle} --host 127.0.0.1 --port ${port} --strictPort`,
      url: baseURL,
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      command: `npm run dev:e2e -- ${devPort}`,
      url: devURL,
      reuseExistingServer: true,
      timeout: 30_000,
    },
  ],
});
