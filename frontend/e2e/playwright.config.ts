import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests against the full docker compose stack (ADR-0010 D6). `e2e/run.sh` starts an isolated compose project,
 * bootstraps its admin and runs these tests; they never touch a developer's local data.
 */
export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env['CHAIN_E2E_BASE_URL'] ?? 'http://localhost:54200',
    locale: 'pt-BR',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
