import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, shell, type WebContents } from "electron";
import { registerAlarmAdapterIpc } from "./alarmHandlers.js";
import { registerAlarmSoundProtocol, registerAlarmSoundScheme } from "./assetPath.js";
import { createDeviceStore } from "./deviceStore.js";
import { ElectronAlarmAdapter } from "./ElectronAlarmAdapter.js";
import { ElectronStoreAdapter } from "./ElectronStoreAdapter.js";
import { registerDeviceAdapterIpc } from "./ipcHandlers.js";
import { registerRebootEscape } from "./rebootEscape.js";
import { registerSettingsAdapterIpc } from "./settingsHandlers.js";
import { registerStoreAdapterIpc } from "./storeHandlers.js";

/**
 * Electron main process.
 *
 * Dev: BrowserWindow loads the Vite dev server at http://localhost:5173 — the
 * renderer workspace (`@cookietodo/renderer`) is pnpm-filtered via the root
 * `dev` task and runs in the same process tree.
 *
 * Prod: BrowserWindow loads the built static bundle from
 * `node_modules/@cookietodo/renderer/dist/index.html`.
 *
 * Slice 2 wires the main-process `DeviceAdapter` (backed by Electron
 * `safeStorage` -> OS keychain) and registers the 8 `ipcMain.handle`
 * channels the preload proxy reads. The renderer's `window.cookietodoDeviceAdapter`
 * proxy routes through `ipcRenderer.invoke` so each adapter method returns a
 * Promise to React (ADR 0009 Decision B + ADR 0010).
 */

const __dirname_subst = dirname(fileURLToPath(import.meta.url));
const isDev = process.env.ELECTRON_IS_DEV === "1";
const RENDERER_DEV_URL = "http://localhost:5173";
const RENDERER_PROD_PATH = join(
  __dirname_subst,
  "..",
  "..",
  "..",
  "..",
  "node_modules",
  "@cookietodo",
  "renderer",
  "dist",
  "index.html",
);

// Slice 5: the custom alarm-sound scheme must be declared privileged BEFORE
// app readiness (Electron API contract); the protocol handler itself is
// registered inside `app.whenReady()` below.
registerAlarmSoundScheme();

async function createWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: join(__dirname_subst, "..", "preload", "index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  if (isDev) {
    await win.loadURL(RENDERER_DEV_URL);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    await win.loadFile(RENDERER_PROD_PATH);
  }
  return win;
}

void app.whenReady().then(async () => {
  // Slice 5: serve the cookietodo-sound:// scheme (handler must be registered
  // after readiness; the scheme declaration above ran pre-ready).
  registerAlarmSoundProtocol();
  // Register the DeviceAdapter's IPC handlers BEFORE the first BrowserWindow
  // is created so the renderer's `window.cookietodoDeviceAdapter()` calls
  // (fired on first useEffect) cannot race the binding of the matching
  // `ipcMain.handle` channel on the main side.
  registerDeviceAdapterIpc(createDeviceStore());
  // Slice-3: Store IPC must register before createWindow — App's
  // `window.cookietodoStoreAdapter().loadSnapshot()` fires on mount.
  registerStoreAdapterIpc(new ElectronStoreAdapter());
  // Slice-5: Alarm IPC must register before createWindow — the Alarm Event
  // window (opened on fire) needs the alarm channel + the main window ref for
  // the main→renderer `cookietodo:alarm:fired` push. `mainWindow` is assigned
  // below; the accessor is lazy so fires before/after assignment both work.
  registerAlarmAdapterIpc(new ElectronAlarmAdapter(() => mainWindowWebContents()));
  // Slice-4: Settings IPC (Import/Export native dialogs) must register before
  // createWindow — the SettingsView overlay's
  // `window.cookietodoSettingsAdapter()` calls fire on overlay mount.
  registerSettingsAdapterIpc();
  // Slice-6: reboot-escape banner trigger — fires on `will-quit` +
  // `session-end` to flag every escaped Reminder (alarm fired / past-due
  // armed, joined to an uncompleted Todo) with `pendingPostRebootBanner`
  // before the next launch reads it (ADR 0007 — Issue #7 AC #7-#8).
  registerRebootEscape(`${app.getPath("userData")}/snapshot.json`);
  mainWindow = await createWindow();
  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = await createWindow();
    }
  });
});

let mainWindow: BrowserWindow | null = null;

/**
 * Lazy accessor for the main window's webContents — resolved at alarm-fire
 * time so the adapter pushes the fire payload to the app's primary window
 * (the one whose renderer store owns the Reminder state).
 */
function mainWindowWebContents(): WebContents | null {
  return mainWindow?.webContents ?? null;
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
