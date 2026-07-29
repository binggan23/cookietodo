import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, shell } from "electron";

/**
 * Electron main process for slice 1.
 *
 * Dev: BrowserWindow loads the Vite dev server at http://localhost:5173 — the
 * renderer workspace (`@cookietodo/renderer`) is pnpm-filtered via the root
 * `dev` task and runs in the same process tree.
 *
 * Prod: BrowserWindow loads the built static bundle from
 * `node_modules/@cookietodo/renderer/dist/index.html`. (Slice 1 is dev-only
 * boot verification; the prod-build wiring is exercised in slice 2.)
 *
 * The preload script installs the in-memory `DeviceAdapter` stub backed by
 * `localStorage` on the renderer's `window` (replaced by `safeStorage` in slice 2).
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

async function createWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: join(__dirname_subst, "..", "preload", "index.js"),
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
  await createWindow();
  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
