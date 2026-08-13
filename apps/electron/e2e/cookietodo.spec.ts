import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

async function launchCookietodo(
  userDataDir: string,
  fakeDialogDir?: string,
): Promise<ElectronApplication> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    COOKIETODO_E2E_INSECURE_DEVICE_STORE: "1",
    ELECTRON_IS_DEV: "1",
    NODE_ENV: "development",
  };
  if (fakeDialogDir !== undefined) {
    env.COOKIETODO_E2E_FAKE_DIALOG_DIR = fakeDialogDir;
  }
  return electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`, "--disable-gpu", "--no-sandbox"],
    env,
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

/**
 * Same as {@link typePasswordSlots} but tolerates a "Target page ... has been
 * closed" thrown by the trailing keypress — which is the expected outcome
 * when the 6th digit triggers `dismissAlarm` and the shell closes the alarm
 * window mid-press. Mirrors slice-5's dismiss-click `.catch(() => {})` pattern.
 */
async function typePasswordSlotsTolerant(page: Page, code: string): Promise<void> {
  await page.getByTestId("password-slot-0").click();
  for (let i = 0; i < code.length; i += 1) {
    const slot = page.getByTestId(`password-slot-${i}`);
    try {
      await expect(slot).toBeVisible({ timeout: 1_000 });
      await slot.press(code[i] ?? "");
    } catch (err) {
      // The 6th digit triggers dismissAlarm (IPC), which tears down the page.
      // The "Target page has been closed" / locator-not-found here is the
      // expected outcome once the close is in flight — break the loop, since
      // the closePromise is armed in the caller.
      void err;
      return;
    }
  }
}

async function clickEnabledContinue(page: Page): Promise<void> {
  const button = page.getByRole("button", { name: "继续" });
  await expect(button).toBeEnabled();
  await button.click();
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
  await clickEnabledContinue(page);

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
  await clickEnabledContinue(page);

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
  await clickEnabledContinue(page);
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

/**
 * Converts an epoch-ms Date to the local `datetime-local` input value format
 * `YYYY-MM-DDTHH:mm` (no timezone — `new Date(localInput)` recovers epoch ms
 * in the browser's local timezone, which is what the test expects since the
 * Store round-trip is via epoch ms per ADR 0006).
 */
function toLocalDateTimeInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Slice-3 verification seam — Todo + List CRUD round-trips across a relaunch,
 * and `snapshot.json` carries the live List + the deletion tombstone to disk
 * (ADR 0003 persistence + ADR 0004 tombstones).
 */
test("slice-3: Todo + List CRUD round-trips across relaunch", async () => {
  const userDataDir = await freshUserDataDir();

  // --- Session 1: first-launch flow → home ---
  let app = await launchCookietodo(userDataDir);
  let page = await app.firstWindow();
  await page.getByRole("button", { name: "继续" }).click();
  await expect(page.getByTestId("password-setup-screen")).toBeVisible();
  await typePasswordSlots(page, TEST_PASSWORD);
  await expect(page.getByTestId("password-confirm-screen")).toBeVisible();
  await typePasswordSlots(page, TEST_PASSWORD);
  await clickEnabledContinue(page);
  await expect(page.locator('[data-testid="hello-screen"]')).toBeVisible();
  await expect(page.getByText("欢迎使用 cookietodo")).toBeVisible();

  // --- Create List "Work" with a color ---
  await page.getByTestId("home.create-list").click();
  await expect(page.getByTestId("list-form")).toBeVisible();
  await page.getByTestId("list-form.name").fill("Work");
  await page.getByTestId("list-form.color").fill("#3b82f6");
  await page.getByTestId("list-form.save").click();
  await expect(page.getByText("Work")).toBeVisible();

  // --- Create a Todo with note + dueAt + listIds; Reminder toggle off ---
  await page.getByTestId("home.create-todo").click();
  await expect(page.getByTestId("todo-form")).toBeVisible();
  await page.getByTestId("todo-form.title").fill("Write plan");
  await page.getByTestId("todo-form.notes").fill("# heading\nbody");
  // Preview renders Markdown via react-markdown; assert H1 surfaces.
  await page.locator(".notes-mode button").nth(1).click();
  await expect(page.getByTestId("todo-form.notes-preview").locator("h1")).toHaveText("heading");
  await page.locator(".notes-mode button").nth(0).click();

  const dueAtLocal = toLocalDateTimeInput(Date.now() + 86_400_000);
  await page.getByTestId("todo-form.due-at").fill(dueAtLocal);
  await page.getByTestId("todo-form.list-ids").selectOption({ label: "Work" });
  await expect(page.getByTestId("todo-form.reminder-toggle")).toBeVisible();
  await page.getByTestId("todo-form.save").click();

  // --- The new Todo appears in the home view ---
  await expect(page.getByTestId("todo-item.Write plan.completed")).toBeVisible();

  // --- Toggle completed ---
  await page.getByTestId("todo-item.Write plan.complete").click();
  await expect(page.getByTestId("todo-item.Write plan.complete")).toHaveText("取消完成");

  // --- Delete Todo → tombstone appears in Recently Deleted ---
  await page.getByTestId("todo-item.Write plan.delete").click();
  await expect(page.getByTestId("recently-deleted")).toBeVisible();
  await expect(page.locator('[data-testid^="tombstone."][data-testid$=".restore"]')).toHaveCount(1);

  // --- Cross-session persistence: app.close() + relaunch SAME userDataDir ---
  await app.close();
  app = await launchCookietodo(userDataDir);
  page = await app.firstWindow();
  await expect(page.locator('[data-testid="hello-screen"]')).toBeVisible();
  await expect(page.getByText("Work")).toBeVisible();
  // Todo is gone from the active list; tombstone survived the relaunch.
  await expect(page.getByTestId("todo-item.Write plan.completed")).toHaveCount(0);
  await expect(page.locator('[data-testid^="tombstone."][data-testid$=".restore"]')).toHaveCount(1);
  await app.close();

  // --- Inspect on-disk snapshot.json (ADR 0003). Confirm Work list +
  // todo-kind tombstone persisted (ADR 0004 + ADR 0006).
  const snapshotRaw = await readFile(`${userDataDir}/snapshot.json`, "utf8");
  const snapshot = JSON.parse(snapshotRaw) as {
    lists: { name: string; color: string | null }[];
    deleted: { id: string; kind: "todo" | "list"; deletedAt: number }[];
  };
  expect(snapshot.lists.map((l) => l.name)).toContain("Work");
  expect(snapshot.deleted.filter((d) => d.kind === "todo")).toHaveLength(1);

  await rm(userDataDir, { recursive: true, force: true });
});

/**
 * Slice-4 verification seam — Snapshot Import/Export round-trip with
 * JSONC-tolerant Import (ADR 0001 + ADR 0003 + ADR 0008 failure UX).
 *
 * Cases covered (mirrors issue #5 acceptance criteria):
 *   1. Export → verify file exists + strict-JSON → in-app change → Import
 *      prior → Store reverted (with fake-dialog env gate).
 *   2. Canonical round-trip test: same snapshot data exported from different
 *      mutation orders produces byte-identical bytes.
 *   3. JSONC input with comments + trailing commas imports cleanly; the
 *      re-export is byte-identical to the strict-JSON canonical form.
 *   4. Forward-compat: a Snapshot missing the `deleted` field defaults to
 *      `[]` via Zod `.default(...)`; import succeeds.
 *   5. Back-compat: a Snapshot carrying an unknown top-level key (`future`)
 *      imports cleanly AND the unknown key is preserved on re-export.
 *   6. Corrupt JSONC input is rejected with a clear UI error string; the
 *      in-memory Store is untouched (asserted by post-error Store state).
 */
async function driveFirstLaunchToHome(page: Page): Promise<void> {
  await page.getByRole("button", { name: "继续" }).click();
  await expect(page.getByTestId("password-setup-screen")).toBeVisible();
  await typePasswordSlots(page, TEST_PASSWORD);
  await expect(page.getByTestId("password-confirm-screen")).toBeVisible();
  await typePasswordSlots(page, TEST_PASSWORD);
  await clickEnabledContinue(page);
  await expect(page.locator('[data-testid="hello-screen"]')).toBeVisible();
}

async function openSettings(page: Page): Promise<void> {
  await page.getByTestId("home.open-settings").click();
  await expect(page.getByTestId("settings-overlay")).toBeVisible();
}

test("slice-4: Export → in-app change → Import prior → Store reverted", async () => {
  const userDataDir = await freshUserDataDir();
  const dialogDir = await mkdtemp(join(tmpdir(), "cookietodo-fake-dialog-"));
  const app = await launchCookietodo(userDataDir, dialogDir);
  const page = await app.firstWindow();
  await driveFirstLaunchToHome(page);

  // Seed: create one List + one Todo so the Store is non-empty.
  await page.getByTestId("home.create-list").click();
  await page.getByTestId("list-form.name").fill("Work");
  await page.getByTestId("list-form.color").fill("#3b82f6");
  await page.getByTestId("list-form.save").click();
  await expect(page.getByText("Work")).toBeVisible();

  await page.getByTestId("home.create-todo").click();
  await page.getByTestId("todo-form.title").fill("Seeded todo");
  await page.getByTestId("todo-form.notes").fill("seed");
  await page.getByTestId("todo-form.save").click();
  await expect(page.getByTestId("todo-item.Seeded todo.completed")).toBeVisible();

  // Export the seeded snapshot via Settings → Export. Fake-dialog will write
  // to <dialogDir>/export.todo.json.
  await openSettings(page);
  await page.getByTestId("settings.export").click();
  await expect(page.getByTestId("settings.feedback.success")).toBeVisible();
  await page.getByTestId("settings.close").click();

  const exportPath = join(dialogDir, "export.todo.json");
  const exportedRaw = await readFile(exportPath, "utf8");
  // Strict-JSON: every value is parseable; no comments.
  expect(() => JSON.parse(exportedRaw)).not.toThrow();
  const exported = JSON.parse(exportedRaw) as {
    todos: { title: string }[];
    lists: { name: string }[];
  };
  expect(exported.todos.map((t) => t.title)).toContain("Seeded todo");
  expect(exported.lists.map((l) => l.name)).toContain("Work");

  // In-app change: delete the todo so the Store diverges from the exported
  // snapshot. Then Import the prior export and assert the Store reverted.
  await page.getByTestId("todo-item.Seeded todo.delete").click();
  await expect(page.getByTestId("todo-item.Seeded todo.completed")).toHaveCount(0);

  // Pre-stage the import fixture file (fake dialog reads from <dialogDir>/import.todo.json).
  await writeFile(join(dialogDir, "import.todo.json"), exportedRaw, "utf8");
  await openSettings(page);
  await page.getByTestId("settings.import").click();
  await expect(page.getByTestId("settings.feedback.success")).toBeVisible();

  // Store reverted — the previously-deleted Todo re-appears in the active list.
  await page.getByTestId("settings.close").click();
  await expect(page.getByTestId("todo-item.Seeded todo.completed")).toBeVisible();
  await expect(page.getByText("Work")).toBeVisible();

  await app.close();
  await rm(userDataDir, { recursive: true, force: true });
  await rm(dialogDir, { recursive: true, force: true });
});

test("slice-4: JSONC input with comments + trailing commas imports", async () => {
  const userDataDir = await freshUserDataDir();
  const dialogDir = await mkdtemp(join(tmpdir(), "cookietodo-fake-dialog-"));
  const fixturePath = join(dialogDir, "import.todo.json");
  const jsoncFixture = `{
  // forward-compat: comments are stripped by the JSONC parser
  "todos": [
    {
      "id": "01HZX9T6V7EJ4W1ZAG7Q2X3KPC",
      "title": "JSONC todo",
      "notes": "",
      "listIds": [],
      "completed": false,
      "completedAt": null,
      "dueAt": null,
      "reminderId": null,
      "createdAt": 1700000000000,
      "updatedAt": 1700000000000,
      "revision": 0,
    },
  ],
  "lists": [],
  "reminders": [],
  "deleted": [],
  "schemaVersion": 1,
}`;
  await writeFile(fixturePath, jsoncFixture, "utf8");

  const app = await launchCookietodo(userDataDir, dialogDir);
  const page = await app.firstWindow();
  await driveFirstLaunchToHome(page);

  await openSettings(page);
  await page.getByTestId("settings.import").click();
  await expect(page.getByTestId("settings.feedback.success")).toBeVisible();

  // Import renders the new todo; JSONC-tolerant parse produced a canonical
  // Snapshot and the Store replaced atomically.
  await page.getByTestId("settings.close").click();
  await expect(page.getByTestId("todo-item.JSONC todo.completed")).toBeVisible();

  // Round-trip canonical: re-export and verify the bytes match the strict-JSON
  // canonical form (comments + trailing commas stripped, stable key order).
  await openSettings(page);
  await page.getByTestId("settings.export").click();
  await expect(page.getByTestId("settings.feedback.success")).toBeVisible();
  await page.getByTestId("settings.close").click();

  const exportPath = join(dialogDir, "export.todo.json");
  const canonicalBytes = await readFile(exportPath, "utf8");
  const expectedCanonical = JSON.stringify(
    {
      todos: [
        {
          id: "01HZX9T6V7EJ4W1ZAG7Q2X3KPC",
          title: "JSONC todo",
          notes: "",
          listIds: [],
          completed: false,
          completedAt: null,
          dueAt: null,
          reminderId: null,
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
          revision: 0,
        },
      ],
      lists: [],
      reminders: [],
      deleted: [],
      schemaVersion: 1,
    },
    null,
    2,
  );
  expect(canonicalBytes).toBe(expectedCanonical);

  await app.close();
  await rm(userDataDir, { recursive: true, force: true });
  await rm(dialogDir, { recursive: true, force: true });
});

test("slice-4: forward-compat (missing `deleted` field) + back-compat (unknown key preserved)", async () => {
  const userDataDir = await freshUserDataDir();
  const dialogDir = await mkdtemp(join(tmpdir(), "cookietodo-fake-dialog-"));
  // Older-version fixture: missing the `deleted` collection; the Zod
  // `.default([])` on SnapshotSchema makes up the missing field.
  const olderFixture = JSON.stringify(
    {
      todos: [],
      lists: [
        {
          id: "01HZX9T6V7EJ4W1ZAG7Q2X3KPD",
          name: "Older-version list",
          color: null,
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
          revision: 0,
        },
      ],
      reminders: [],
      // `deleted` deliberately absent — Zod `.default([])` step in.
    },
    null,
    2,
  );
  await writeFile(join(dialogDir, "import.todo.json"), olderFixture, "utf8");

  const app = await launchCookietodo(userDataDir, dialogDir);
  const page = await app.firstWindow();
  await driveFirstLaunchToHome(page);

  await openSettings(page);
  await page.getByTestId("settings.import").click();
  await expect(page.getByTestId("settings.feedback.success")).toBeVisible();
  await page.getByTestId("settings.close").click();
  await expect(page.getByText("Older-version list")).toBeVisible();

  // Back-compat: a NEWER-version snapshot carrying an unknown top-level key
  // (`future: {…}`) imports and the unknown key survives a re-export. Stage it
  // at the fake-dialog import path and re-import.
  const newerFixture = JSON.stringify(
    {
      todos: [],
      lists: [],
      reminders: [],
      deleted: [],
      schemaVersion: 1,
      future: { unknownField: "preserved" },
    },
    null,
    2,
  );
  await writeFile(join(dialogDir, "import.todo.json"), newerFixture, "utf8");
  await openSettings(page);
  await page.getByTestId("settings.import").click();
  await expect(page.getByTestId("settings.feedback.success")).toBeVisible();
  await page.getByTestId("settings.close").click();

  // Re-export and assert the unknown key IS in the strict-JSON re-export
  // (forward-compat: `.catchall(z.unknown())` preserved unknown keys via
  // the Zod round-trip).
  await openSettings(page);
  await page.getByTestId("settings.export").click();
  await expect(page.getByTestId("settings.feedback.success")).toBeVisible();
  await page.getByTestId("settings.close").click();

  const reExport = JSON.parse(await readFile(join(dialogDir, "export.todo.json"), "utf8")) as {
    future?: unknown;
  };
  expect(reExport.future).toEqual({ unknownField: "preserved" });

  await app.close();
  await rm(userDataDir, { recursive: true, force: true });
  await rm(dialogDir, { recursive: true, force: true });
});

test("slice-4: corrupt JSONC input is rejected with a clear UI message and Store untouched", async () => {
  const userDataDir = await freshUserDataDir();
  const dialogDir = await mkdtemp(join(tmpdir(), "cookietodo-fake-dialog-"));
  // Corrupt fixture: not valid JSON OR JSONC (missing closing brace, dangling
  // comma inside the trailing brace with no following key).
  const corruptFixture = '{ "todos": [ { ';
  await writeFile(join(dialogDir, "import.todo.json"), corruptFixture, "utf8");

  const app = await launchCookietodo(userDataDir, dialogDir);
  const page = await app.firstWindow();
  await driveFirstLaunchToHome(page);

  // Seed a List so the Store has observable "before" state.
  await page.getByTestId("home.create-list").click();
  await page.getByTestId("list-form.name").fill("Anchor");
  await page.getByTestId("list-form.color").fill("#3b82f6");
  await page.getByTestId("list-form.save").click();
  await expect(page.getByText("Anchor")).toBeVisible();

  // Import the corrupt file — Expect a clear UI error, NO store mutation.
  await openSettings(page);
  await page.getByTestId("settings.import").click();
  await expect(page.getByTestId("settings.feedback.error")).toBeVisible();
  await page.getByTestId("settings.close").click();

  // Store untouched: the "Anchor" list is still present.
  await expect(page.getByText("Anchor")).toBeVisible();

  await app.close();
  await rm(userDataDir, { recursive: true, force: true });
  await rm(dialogDir, { recursive: true, force: true });
});

/**
 * Slice-5 verification seam — the Alarm Event fires end-to-end on desktop
 * (ADR 0002 Level B + ADR 0007 + ADR 0009 Decision A).
 *
 * Flows:
 *   1. First launch → home (reuses `driveFirstLaunchToHome`).
 *   2. Create a Todo with a `dueAt` set to the NEXT minute boundary (the
 *      `datetime-local` input is minute-precision — AC #3's "5 seconds in
 *      the future" is expressed as "at the next minute boundary, ≤ 60s out",
 *      which is the smallest deterministic value the form can express).
 *   3. Toggle the Reminder ON (enabled now that `dueAt` is non-null — AC #1);
 *      the `triggerAt` input auto-fills with the same `dueAt` value (AC #4).
 *   4. Save → Store writes a Reminder entity + calls
 *      `ElectronAlarmAdapter.scheduleAlarm` (Node `setTimeout`).
 *   5. Wait for the fullscreen Alarm Event `BrowserWindow` (AC #3:
 *      `alwaysOnTop / fullscreen / skipTaskbar`), assert the Todo title is
 *      visible (AC #5), tap Dismiss (AC #5 placeholder), assert the window
 *      closes (window count 2 → 1).
 *
 * Audio presence is NOT asserted — CI containers often lack an audio device;
 * the seam's contract is the window lifecycle + dismiss, and the tone's
 * audibility is covered by the `<audio src>` attribute being set to the
 * `cookietodo-sound://` URL (the main process serves it; CI just can't emit
 * sound).
 */
function nextMinuteLocalInput(): string {
  const d = new Date();
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  return toLocalDateTimeInput(d.getTime());
}

/**
 * Count the app's live windows EXCLUDING the detached DevTools window — dev
 * mode (`ELECTRON_IS_DEV=1`) calls `openDevTools({ mode: "detach" })` in
 * `main/index.ts`, which spawns an extra `BrowserWindow` that would otherwise
 * make "window count" assertions flaky (main + alarm + devtools = 3).
 */
function liveWindowCount(app: ElectronApplication): number {
  return app.windows().filter((w) => !w.isClosed() && !w.url().startsWith("devtools://")).length;
}

test("slice-6: 6-digit password dismisses alarm window atomically completes the Todo", async () => {
  test.setTimeout(120_000); // boundary wait (up to 60s) + 6-digit paint
  const userDataDir = await freshUserDataDir();
  const app = await launchCookietodo(userDataDir);
  const page = await app.firstWindow();
  await driveFirstLaunchToHome(page);

  await page.getByTestId("home.create-todo").click();
  await expect(page.getByTestId("todo-form")).toBeVisible();
  await page.getByTestId("todo-form.title").fill("Slice6 wake");
  const dueAtLocal = nextMinuteLocalInput();
  await page.getByTestId("todo-form.due-at").fill(dueAtLocal);
  await expect(page.getByTestId("todo-form.reminder-toggle")).toBeEnabled();
  await page.getByTestId("todo-form.reminder-toggle").check();
  await expect(page.getByTestId("todo-form.reminder-trigger-at")).toHaveValue(dueAtLocal);
  await page.getByTestId("todo-form.save").click();
  await expect(page.getByTestId("todo-item.Slice6 wake.completed")).toBeVisible();

  const alreadyOpen = app.windows().find((w) => w.url().includes("/alarm"));
  const alarmWindow =
    alreadyOpen ??
    (await app.waitForEvent("window", {
      predicate: (w) => w.url().includes("/alarm"),
      timeout: 90_000,
    }));
  await alarmWindow.waitForLoadState("domcontentloaded");
  await expect.poll(() => liveWindowCount(app), { timeout: 10_000 }).toBe(2);

  await expect(alarmWindow.getByTestId("alarm-event")).toBeVisible();
  await expect(alarmWindow.getByTestId("alarm-event.todo-title")).toHaveText("Slice6 wake");

  // Correct password — testid payload uses `password-slot-{i}` for the
  // shared `PasswordInput` component (the same surface slice-2's
  // first-launch uses; that `typePasswordSlots` helper applies verbatim).
  // The 6th keypress triggers `dismissAlarm` (an IPC round-trip that the
  // shell closes the alarm window over); Playwright's `press` may observe
  // the page closing mid-gesture, so the closePromise is armed BEFORE the
  // password is typed and any "Target page has been closed" thrown by the
  // trailing keypress is swallowed — exactly mirroring slice-5's Pre-slice-6
  // dismiss-click race pattern.
  const closePromise = alarmWindow.waitForEvent("close", { timeout: 15_000 });
  await typePasswordSlotsTolerant(alarmWindow, TEST_PASSWORD);
  await closePromise;

  await expect.poll(() => liveWindowCount(app), { timeout: 10_000 }).toBe(1);

  // Atomic dismiss-as-complete (Issue #7 AC #1-#3): Todo row transitioned
  // to completed and shows the "un-complete" affordance (`取消完成` zh-CN).
  await expect(page.getByTestId("todo-item.Slice6 wake.complete")).toHaveText("取消完成");

  await app.close();
  await rm(userDataDir, { recursive: true, force: true });
});

test("slice-6: wrong password keeps alarm window open; correct code then dismisses", async () => {
  test.setTimeout(120_000); // boundary wait (up to 60s) + 6-digit paint twice
  const userDataDir = await freshUserDataDir();
  const app = await launchCookietodo(userDataDir);
  const page = await app.firstWindow();
  await driveFirstLaunchToHome(page);

  await page.getByTestId("home.create-todo").click();
  await expect(page.getByTestId("todo-form")).toBeVisible();
  await page.getByTestId("todo-form.title").fill("Slice6 wrong pw");
  const dueAtLocal = nextMinuteLocalInput();
  await page.getByTestId("todo-form.due-at").fill(dueAtLocal);
  await expect(page.getByTestId("todo-form.reminder-toggle")).toBeEnabled();
  await page.getByTestId("todo-form.reminder-toggle").check();
  await page.getByTestId("todo-form.save").click();

  const alarmWindow =
    app.windows().find((w) => w.url().includes("/alarm")) ??
    (await app.waitForEvent("window", {
      predicate: (w) => w.url().includes("/alarm"),
      timeout: 90_000,
    }));
  await alarmWindow.waitForLoadState("domcontentloaded");

  // Wrong code: the alarm-event view reveals the wrong-password alert, clears
  // the pad for re-entry, and the window stays open (Issue #7 AC #4 — no rate
  // limit, no hint of partial correctness, alarm does not resume earlier).
  await typePasswordSlots(alarmWindow, MISMATCH_PASSWORD);
  await expect(alarmWindow.getByTestId("alarm-event.wrong-password")).toBeVisible();
  await expect.poll(() => liveWindowCount(app), { timeout: 5_000 }).toBe(2);

  // Correct code now closes the window and clears the pad -> atomic dismiss.
  // Same close-race as the happy-path test — the 6th key triggers dismissAlarm
  // (IPC) which the shell closes over; closePromise is armed first and any
  // trailing "Target page has been closed" is swallowed by the tolerant variant.
  const closePromise = alarmWindow.waitForEvent("close", { timeout: 15_000 });
  await typePasswordSlotsTolerant(alarmWindow, TEST_PASSWORD);
  await closePromise;
  await expect.poll(() => liveWindowCount(app), { timeout: 10_000 }).toBe(1);

  await expect(page.getByTestId("todo-item.Slice6 wrong pw.complete")).toHaveText("取消完成");

  await app.close();
  await rm(userDataDir, { recursive: true, force: true });
});

/**
 * Slice-6 reboot-escape e2e (Issue #7 AC #7-#8 + ADR 0007 "Reboot escape"):
 * alarm fires → user powers off / force-quits without dismissing → on next
 * launch the home view surfaces a `pendingPostRebootBanner` joined to the
 * escaped Todo, and the user can dismiss the banner (Todo stays un-completed
 * — the alarm wasn't actually addressed).
 *
 * Why past-dueAt: the slice-5 alarm-fires-at-next-minute test pays a
 * 0–60s real-time wait because the `datetime-local` input clamps to the
 * nearest future minute. Here, we want the alarm to fire deterministically
 * within the test budget; filling a past `dueAt` lands in the `Reminder`
 * schema and `scheduleAlarm`'s `Math.max(0, triggerAt - Date.now())` arm
 * fires immediately, so the alarm window opens within milliseconds of the
 * form save — no minute-boundary wait. The Todo schema accepts past `dueAt`
 * (epoch ms; no schema-side clamp — ADR 0006 only constrains that
 * `reminderId != null` requires `dueAt != null`, not a future value).
 *
 * The close path: `app.close()` triggers `before-quit` (the
 * `registerRebootEscape` trigger), which synchronously rewrites the on-disk
 * `snapshot.json` to set `pendingPostRebootBanner: true` for every escaped
 * Reminder whose Todo is un-completed (the canonical matcher lives in
 * `src/src/persistence/markRebootEscapes.ts`; the Electron main-process
 * mirror is in `apps/electron/main/rebootEscape.ts` — drift-guard contract
 * in that file's docstring).
 */
test("slice-6: alarm skipped by reboot surfaces post-reboot banner on next launch", async () => {
  test.setTimeout(90_000); // 2 launches + alarm-hop + relaunch assertion
  const userDataDir = await freshUserDataDir();

  let app = await launchCookietodo(userDataDir);
  let page = await app.firstWindow();
  await driveFirstLaunchToHome(page);

  // ARM: create an alarm Todo with a past `dueAt` so it fires immediately.
  await page.getByTestId("home.create-todo").click();
  await expect(page.getByTestId("todo-form")).toBeVisible();
  await page.getByTestId("todo-form.title").fill("Skipped");
  const pastDueLocal = toLocalDateTimeInput(Date.now() - 60_000);
  await page.getByTestId("todo-form.due-at").fill(pastDueLocal);
  await expect(page.getByTestId("todo-form.reminder-toggle")).toBeEnabled();
  await page.getByTestId("todo-form.reminder-toggle").check();
  await page.getByTestId("todo-form.save").click();

  // Let the alarm fire (deterministic on past-dueAt — fires within
  // milliseconds of `scheduleAlarm`). The alarm window opens; we do NOT
  // dismiss it. Closing the app with the alarm window open simulates a
  // reboot/power-off mid-alarm: `before-quit` → `markRebootEscapesToFile`
  // rewrites snapshot.json setting `pendingPostRebootBanner: true`.
  await app.waitForEvent("window", {
    predicate: (w) => w.url().includes("/alarm"),
    timeout: 15_000,
  });
  await app.close();

  // RELAUNCH — fresh Electron process on the SAME userDataDir. The on-disk
  // snapshot has the escaped Reminder flagged; the renderer's HomeView
  // reads it on the `loadSnapshot` subscription and renders the bypass
  // banner. The Todo is NOT silently completed (AC #7 invariant).
  app = await launchCookietodo(userDataDir);
  page = await app.firstWindow();
  await expect(page.locator('[data-testid="hello-screen"]')).toBeVisible();

  await expect(page.getByTestId("alarm-bypass-banner.Skipped")).toBeVisible();
  // AC #7 invariant: the Todo stays un-completed through the reboot.
  await expect(page.getByTestId("todo-item.Skipped.complete")).toHaveText("完成");
  // Underlying Reminder state stays `fired` — only the banner was added.
  // The banner-dismiss button is rendered next to it.
  await expect(page.getByTestId("alarm-bypass.banner.dismiss")).toBeVisible();

  // Click `dismiss` — HomeView's clearRebootBanner clears the flag only;
  // the Reminder stays `fired` (the user must complete the Todo via the
  // row's own UI to truly close the loop).
  await page.getByTestId("alarm-bypass.banner.dismiss").click();
  await expect(page.getByTestId("alarm-bypass-banner.Skipped")).toHaveCount(0);
  await expect(page.getByTestId("todo-item.Skipped.complete")).toHaveText("完成");

  await app.close();
  await rm(userDataDir, { recursive: true, force: true });
});

/**
 * Slice-7 verification seam — manual Sync with 3-way field-level merge.
 *
 * Flow:
 *   1. First launch → home, create a Todo with a List.
 *   2. Export the snapshot (Snapshot A — local state).
 *   3. In-app change: delete the Todo.
 *   4. Import a pre-built Snapshot B (remote state with a different title)
 *      via the Settings → Sync now flow (which reuses the SettingsAdapter
 *      import dialog to pick the remote snapshot file).
 *   5. Assert the merged result has the expected merged state.
 *   6. Open Sync history, verify the merge entry exists.
 *   7. Revert last merge and assert the state goes back to the local state.
 */
test("slice-7: manual Sync now merges local + remote, history shows the merge, revert works", async () => {
  const userDataDir = await freshUserDataDir();
  const dialogDir = await mkdtemp(join(tmpdir(), "cookietodo-fake-dialog-"));
  const app = await launchCookietodo(userDataDir, dialogDir);
  const page = await app.firstWindow();
  await driveFirstLaunchToHome(page);

  // --- Seed: create a List + Todo ---
  await page.getByTestId("home.create-list").click();
  await page.getByTestId("list-form.name").fill("Work");
  await page.getByTestId("list-form.color").fill("#3b82f6");
  await page.getByTestId("list-form.save").click();
  await expect(page.getByText("Work")).toBeVisible();

  await page.getByTestId("home.create-todo").click();
  await page.getByTestId("todo-form.title").fill("Original title");
  await page.getByTestId("todo-form.notes").fill("Original notes");
  await page.getByTestId("todo-form.save").click();
  await expect(page.getByTestId("todo-item.Original title.completed")).toBeVisible();

  // --- Export the current snapshot (simulates "local device's state") ---
  await openSettings(page);
  await page.getByTestId("settings.export").click();
  await expect(page.getByTestId("settings.feedback.success")).toBeVisible();
  await page.getByTestId("settings.close").click();

  const localSnapshotPath = join(dialogDir, "export.todo.json");
  const localRaw = await readFile(localSnapshotPath, "utf8");
  const localSnapshot = JSON.parse(localRaw) as {
    todos: Array<{ id: string }>;
  };

  // --- In-app change: delete the Todo (simulates local changes before sync) ---
  await page.getByTestId("todo-item.Original title.delete").click();
  await expect(page.getByTestId("todo-item.Original title.completed")).toHaveCount(0);

  // --- Build a "remote" snapshot with a different title (simulates another device) ---
  const remoteTodoId = localSnapshot.todos[0]?.id ?? "01ARZ3V8EPRSWSWXN0V4K0K1TR";
  const remoteSnapshot = {
    todos: [
      {
        id: remoteTodoId,
        title: "Remote title",
        notes: "Remote notes",
        listIds: [],
        completed: false,
        completedAt: null,
        dueAt: null,
        reminderId: null,
        createdAt: 1700000000000,
        updatedAt: 1700000500000,
        revision: 1,
      },
      {
        id: "01ARZ3V8EPRSWSWXN0V4K0K1TA",
        title: "Remote-only todo",
        notes: "From other device",
        listIds: [],
        completed: false,
        completedAt: null,
        dueAt: null,
        reminderId: null,
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
        revision: 0,
      },
    ],
    lists: [],
    reminders: [],
    deleted: [],
    schemaVersion: 1,
  };
  await writeFile(
    join(dialogDir, "import.todo.json"),
    JSON.stringify(remoteSnapshot, null, 2),
    "utf8",
  );

  // --- Open Settings and tap Sync now ---
  await openSettings(page);
  await expect(page.getByTestId("settings.sync-section")).toBeVisible();
  await page.getByTestId("settings.sync-now").click();
  await expect(page.getByTestId("settings.feedback.success")).toBeVisible();

  // --- Assert the merged result ---
  await page.getByTestId("settings.close").click();
  // The original title was deleted locally but modified remotely — modify wins
  await expect(page.getByTestId("todo-item.Remote title.completed")).toBeVisible();
  // The remote-only todo should be visible
  await expect(page.getByTestId("todo-item.Remote-only todo.completed")).toBeVisible();

  // --- Open Sync history and verify the merge entry ---
  await openSettings(page);
  await page.getByTestId("settings.sync-history").click();
  await expect(page.getByTestId("sync-history-overlay")).toBeVisible();
  await expect(page.getByTestId("sync-history-list")).toBeVisible();

  // Expand the first entry
  await page.getByTestId("sync-history.entry.0").click();
  await expect(page.getByTestId("sync-history.entry.0.detail")).toBeVisible();

  // --- Revert last merge via the history entry ---
  await page.getByTestId("sync-history.entry.0.revert").click();
  await page.getByTestId("sync-history.close").click();
  await page.getByTestId("settings.close").click();

  // After revert, the state should be back to the local state
  await expect(page.getByTestId("todo-item.Remote title.completed")).toHaveCount(0);
  await expect(page.getByTestId("todo-item.Remote-only todo.completed")).toHaveCount(0);

  await app.close();
  await rm(userDataDir, { recursive: true, force: true });
  await rm(dialogDir, { recursive: true, force: true });
});

/**
 * Slice 8 — WebDAV sync transport e2e (issue #10).
 */
test("slice-8: WebDAV sync opens settings and configures credentials", async () => {
  const userDataDir = await freshUserDataDir();
  const app = await launchCookietodo(userDataDir);
  const page = await app.firstWindow();
  await driveFirstLaunchToHome(page);

  // Open Settings and verify the WebDAV section exists
  await openSettings(page);
  await expect(page.getByTestId("settings.webdav-section")).toBeVisible();
  await expect(page.getByTestId("settings.webdav.enable")).toBeVisible();

  // Enable WebDAV sync
  await page.getByTestId("settings.webdav.enable").click();
  await page.waitForSelector('[data-testid="settings.webdav.url"]');

  // Enter a dummy WebDAV URL and credentials
  await page.getByTestId("settings.webdav.url").fill("http://localhost:18080");
  await page.getByTestId("settings.webdav.username").fill("e2e");
  await page.getByTestId("settings.webdav.password").fill("e2e");

  // Save credentials
  await page.getByTestId("settings.webdav.save-credentials").click();
  await expect(page.getByTestId("settings.feedback.success")).toBeVisible();

  // Close settings
  await page.getByTestId("settings.close").click();

  await app.close();
  await rm(userDataDir, { recursive: true, force: true });
});
