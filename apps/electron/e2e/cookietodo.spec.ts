import { mkdtemp, rm } from "node:fs/promises";
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
 * The e2e seam (PRD-0001 "The single seam") — slice-2 entry point.
 *
 * Slice 2 extends the slice-1 language-picker flow with the forced 6-digit
 * password-setup + confirmation + landing-on-home (ADR 0010 first-launch
 * chain replaces ADR 0009 Decision B with a single-double mismatch loop per
 * AC: "Mismatched confirmation loops back to the password-set screen with no
 * rate limit, no hint, no frozen state").
 *
 * Flow:
 *   1. Playwright config `webServer` boots the Vite renderer on port 5173.
 *   2. `pree2e` (apps/electron/package.json) compiles main + preload into
 *      `dist-electron/` so Electron loads real JS / a real preload file.
 *   3. We launch the locally-installed `electron` package via Playwright's
 *      `_electron.launch`, point it at the built main, set ELECTRON_IS_DEV=1
 *      so `BrowserWindow.loadURL` hits the already-running Vite dev server.
 *   4. Test 1: first launch drives ADR 0010 language picker → 继续 → ADR 0009
 *      Decision B password setup → confirmation re-entry → hello-screen. The
 *      saved locale + saved password round-trip through the main-process
 *      `safeStorage`-backed `DeviceAdapter` (slice-2's preload proxy → IPC).
 *   5. Test 2: a second window sharing the same `userDataDir` reboots; with
 *      locale + password persisted, it routes straight to home (no picker,
 *      no password-setup) per AC: "Subsequent launch reads the persisted
 *      password + locale and routes directly to home."
 */
const __dirname_subst = dirname(fileURLToPath(import.meta.url));
const MAIN_ENTRY = join(__dirname_subst, "..", "dist-electron", "main", "index.js");

const TEST_PASSWORD = "123456";
const MISMATCH_PASSWORD = "654321";

async function launchCookietodo(userDataDir: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`, "--disable-gpu", "--no-sandbox"],
    env: {
      ...process.env,
      ELECTRON_IS_DEV: "1",
      NODE_ENV: "development",
    },
    timeout: 30_000,
  });
}

async function freshUserDataDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "cookietodo-e2e-"));
}

async function typePasswordSlots(page: Page, code: string): Promise<void> {
  await page.getByTestId("password-slot-0").click();
  for (let i = 0; i < code.length; i += 1) {
    const slot = page.getByTestId(`password-slot-${i}`);
    await expect(slot).toBeVisible();
    await slot.press(code[i] ?? "");
  }
}

test("first launch: language pick -> password setup -> confirm -> home", async () => {
  const userDataDir = await freshUserDataDir();
  const app = await launchCookietodo(userDataDir);
  const page = await app.firstWindow();

  // ADR 0010 picker — both language options + continue visible.
  await expect(page.getByRole("button", { name: "简体中文" })).toBeVisible();
  await expect(page.getByRole("button", { name: "English" })).toBeVisible();
  await expect(page.getByRole("button", { name: "继续" })).toBeVisible();

  // 语言 第默认预选 zh-CN → 点击继续进入密码设置（per ADR 0010 first-launch chain).
  await page.getByRole("button", { name: "继续" }).click();
  await expect(page.getByTestId("password-setup-screen")).toBeVisible();

  // 键入 6 个数字; setup screen auto-advances at 6 digits per AC enforcement.
  await typePasswordSlots(page, TEST_PASSWORD);

  // Confirm screen — re-entry required.
  await expect(page.getByTestId("password-confirm-screen")).toBeVisible();
  await typePasswordSlots(page, TEST_PASSWORD);
  await page.getByRole("button", { name: "继续" }).click();

  // Hello screen — slice-2 home view (`home.welcome` i18n key for zh-CN).
  await expect(page.locator('[data-testid="hello-screen"]')).toBeVisible();
  await expect(page.getByText("欢迎使用 cookietodo")).toBeVisible();

  await app.close();
  await rm(userDataDir, { recursive: true, force: true });
});

test("first-launch mismatch loops back to password setup with banner", async () => {
  const userDataDir = await freshUserDataDir();
  const app = await launchCookietodo(userDataDir);
  const page = await app.firstWindow();

  // Skip picker — default zh-CN继续.
  await page.getByRole("button", { name: "继续" }).click();
  await expect(page.getByTestId("password-setup-screen")).toBeVisible();

  // Set up first, then mismatched confirmation.
  await typePasswordSlots(page, TEST_PASSWORD);
  await expect(page.getByTestId("password-confirm-screen")).toBeVisible();
  await typePasswordSlots(page, MISMATCH_PASSWORD);
  await page.getByRole("button", { name: "继续" }).click();

  // ADR 0009 Decision B mismatch behavior: loops back to setup, banner shown.
  await expect(page.getByTestId("password-setup-screen")).toBeVisible();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByText(/两次输入不一致/)).toBeVisible();

  await app.close();
  await rm(userDataDir, { recursive: true, force: true });
});

test("subsequent launch routes directly to home (locale + password persisted)", async () => {
  const userDataDir = await freshUserDataDir();

  // First launch completes the full flow — leaves locale + password in
  // safeStorage-backed device-store.json.
  let app = await launchCookietodo(userDataDir);
  let page = await app.firstWindow();
  await page.getByRole("button", { name: "继续" }).click();
  await expect(page.getByTestId("password-setup-screen")).toBeVisible();
  await typePasswordSlots(page, TEST_PASSWORD);
  await expect(page.getByTestId("password-confirm-screen")).toBeVisible();
  await typePasswordSlots(page, TEST_PASSWORD);
  await page.getByRole("button", { name: "继续" }).click();
  await expect(page.locator('[data-testid="hello-screen"]')).toBeVisible();
  await app.close();

  // Second launch — fresh Electron process with the SAME userDataDir. The
  // persisted locale + password should route straight to home per AC.
  app = await launchCookietodo(userDataDir);
  page = await app.firstWindow();

  await expect(page.locator('[data-testid="hello-screen"]')).toBeVisible();
  // Picker and password-setup screens never render.
  await expect(page.getByTestId("password-setup-screen")).toHaveCount(0);
  await expect(page.getByTestId("password-confirm-screen")).toHaveCount(0);
  await expect(page.getByText("欢迎使用 cookietodo")).toBeVisible();

  await app.close();
  await rm(userDataDir, { recursive: true, force: true });
});
