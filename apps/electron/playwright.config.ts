import { defineConfig } from "@playwright/test";

/**
 * Playwright config — runs the single e2e seam against the Electron desktop
 * shell. The seam is the ONLY e2e test surface per PRD-0001; subsequent slices
 * extend `e2e/cookietodo.spec.ts`, not add new test files.
 *
 * Slice 1 dev workflow: apps/electron/package.json `dev` boots the Vite renderer
 * (port 5173) and tsx-watches the Electron main. The e2e harness launches its
 * OWN Electron instance (`electron.launch`) and so it expects the dev server
 * already up. We set `webServer` to bring the renderer up + wait for port 5173.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm --filter @cookietodo/renderer dev",
    url: "http://localhost:5173",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
