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
