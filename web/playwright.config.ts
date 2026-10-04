import { defineConfig, devices } from '@playwright/test'

// One fresh in-memory server per project, so each run starts from rules version 1 with an empty ledger.
const server = (port: number) => ({
  command: 'node ../api/node_modules/tsx/dist/cli.mjs ../api/src/dev/e2e-server.ts',
  url: `http://127.0.0.1:${port}/health`,
  reuseExistingServer: false,
  env: { PORT: String(port) },
})

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: [['list']],
  use: { channel: 'chrome', trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { baseURL: 'http://127.0.0.1:8779', viewport: { width: 1440, height: 960 } } },
    { name: 'phone', use: { ...devices['Pixel 7'], channel: 'chrome', baseURL: 'http://127.0.0.1:8778' } },
  ],
  webServer: [server(8779), server(8778)],
})
