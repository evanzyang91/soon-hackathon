// `pnpm e2e`: boots the real HTTPS server (Vite middleware + relay + pipeline) in MOCK mode on its
// own port and data dir, then drives a laptop and a simulated phone in headless Chromium.
//
//   E2E_PORT      server port (default 5390)
//   E2E_DATA_DIR  project store for the run (default: a fresh temp dir per run)
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 5390);
// Set once in the runner process; workers inherit it, so everyone agrees on the directory.
const DATA_DIR = (process.env.E2E_DATA_DIR ??= mkdtempSync(join(tmpdir(), 'previz-e2e-')));
const REPO = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  testDir: 'tests/e2e',
  // loads both pages once so Vite's dependency pre-bundling settles before any test page opens
  globalSetup: './tests/e2e/global-setup.ts',
  // One worker: SwiftShader (software GL) is shared by every page, so parallel specs only slow
  // each other down and make frame-rate based assertions flaky.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    baseURL: `https://localhost:${PORT}`,
    ignoreHTTPSErrors: true,
    // DOM snapshots only: screencast frames are expensive when every frame is software-rendered
    trace: { mode: 'retain-on-failure', screenshots: false, snapshots: true },
    // E2E_SCREENSHOTS=on keeps an end-of-test screenshot of every page (demo evidence)
    screenshot: process.env.E2E_SCREENSHOTS === 'on' ? 'on' : 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 720 },
        launchOptions: {
          // WebGL2 in headless Chromium without a GPU
          args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
        },
      },
    },
  ],
  webServer: {
    command: 'tsx server/index.ts',
    env: {
      MOCK: '1',
      PORT: String(PORT),
      DATA_DIR,
      // keep a developer's MARBLE_DRY_RUN / NODE_ENV out of the run
      MARBLE_DRY_RUN: '0',
      NODE_ENV: 'development',
      VITE_CACHE_DIR: join(REPO, 'node_modules', '.vite-e2e'),
    },
    url: `https://localhost:${PORT}/api/health`,
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
