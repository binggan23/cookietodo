import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from "@playwright/test";

/**
 * The e2e seam (PRD-0001 "The single seam") — slice-1 entry point.
 *
 * Slice 1: boot the Electron shell, assert the language picker → continue →
 * hello cookietodo flow. Subsequent slices extend this same file with
 * password-setup → todo+alarm flows; PRD mandates no new e2e test files.
 *
 * Flow:
 *   1. Playwright config `webServer` boots the Vite renderer on port 5173.
 *   2. `pree2e` (apps/electron/package.json) compiles main + preload into
 *      `dist-electron/` so Electron loads real JS / a real preload file.
 *   3. We launch the locally-installed `electron` package via Playwright's
 *      `_electron.launch`, point it at the built main, set ELECTRON_IS_DEV=1
 *      so `BrowserWindow.loadURL` hits the already-running Vite dev server.
 *   4. First-launch flow per ADR 0010 + ADR 0009: language picker precedes
 *      password setup (password lands slice 2). Default-selected locale is
 *      zh-CN (per ADR 0010 three-step fallback: no user pref, OS locale
 *      detected as zh-CN by the chromium default under Electron).
 *   5. Tapping "继续" persists the locale and routes to hello.
 *   6. Assert the visible "hello cookietodo" string lands on screen.
 */
const __dirname_subst = dirname(fileURLToPath(import.meta.url));
const MAIN_ENTRY = join(__dirname_subst, "..", "dist-electron", "main", "index.js");

async function launchCookietodo(): Promise<ElectronApplication> {
  // Fresh userDataDir per test run so localStorage starts blank and the
  // ADR 0010 first-launch picker renders each invocation.
  const userDataDir = await mkdtemp(join(tmpdir(), "cookietodo-e2e-"));
  return electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      ELECTRON_IS_DEV: "1",
      NODE_ENV: "development",
    },
    timeout: 30_000,
  });
}

test("first-launch language picker routes onward to hello cookietodo", async () => {
  const app = await launchCookietodo();
  const page: Page = await app.firstWindow();

  // Picker screen per ADR 0010: visible language heading + two button options.
  await expect(page.getByRole("button", { name: "简体中文" })).toBeVisible();
  await expect(page.getByRole("button", { name: "English" })).toBeVisible();
  await expect(page.getByRole("button", { name: "继续" })).toBeVisible();

  // The default-preset locale is zh-CN per ADR 0010 fallback chain; click 继续.
  await page.getByRole("button", { name: "继续" }).click();

  // Hello screen per PRD acceptance criterion #1.
  await expect(page.locator('[data-testid="hello-screen"]')).toBeVisible();
  await expect(page.getByText("hello cookietodo")).toBeVisible();

  await app.close();
});
