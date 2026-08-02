/**
 * Slice 5 — desktop `AlarmAdapter` implementation (ADR 0002 + ADR 0007 +
 * ADR 0009 Decision A).
 *
 * Arming is a single Node `setTimeout(triggerAt - Date.now())` clamped to
 * `>= 0` per AC #3 ("on fire it opens a fullscreen `BrowserWindow`"). Idempotent
 * on `reminder.id` (re-schedule cancels the prior timer arm — the contract the
 * store relies on for re-arm-on-updateTodo).
 *
 * On fire:
 *   1. Open a fullscreen `BrowserWindow` (`alwaysOnTop: true, fullscreen: true,
 *      skipTaskbar: true, frame: false` per AC #3).
 *   2. Load the renderer's alarm route via hash query params so the
 *      `<AlarmEventView>` React component reads `reminderId`, `todoId`,
 *      `todoTitle`, and `soundUrl` from the URL (no IPC-after-ready race per
 *      slice-5 design fork #8 — URL params are the cleanest seam).
 *   3. Push the `AlarmFiredPayload` to the main `webContents` via
 *      `mainWindow.webContents.send('cookietodo:alarm:fired', payload)` so the
 *      renderer's store flips `Reminder.state pending → 'fired'` (the
 *      per-instance `onAlarmFired` subscription in `createCookietodoStore`
 *      receives this).
 *   4. Slice 5 hardcodes `soundId: 1` (default per ADR 0009 Decision A); the
 *      tone's `file://` URL is computed via `resolveAlarmSoundUrl`.
 *
 * `cancelAlarm(reminderId)` clears the timer AND closes any open Alarm Event
 * window for that reminder — slice 5's placeholder Dismiss button drives
 * through this path (the renderer's `AlarmEventView` calls
 * `cancelAlarm(reminderId)` on Dismiss, and the main closes the window).
 * Per AC #5, `Reminder.state` stays `'fired'` after Dismiss in slice 5 — the
 * password-dismiss + complete=true semantics land in slice 6.
 *
 * `requestPermission('alarm')` always resolves `'granted'` on desktop (alarm
 * channels already allowed in Electron main context per ADR 0002).
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AlarmAdapter, AlarmFiredPayload } from "@cookietodo/renderer/alarm";
import type { Reminder, Todo } from "@cookietodo/renderer/domain";
import { BrowserWindow, type WebContents } from "electron";
import { resolveAlarmSoundUrl } from "./assetPath.js";

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

/** Window options matching AC #3 — flat fullscreen alarm takeover. */
const ALARM_WINDOW_OPTS = {
  alwaysOnTop: true,
  fullscreen: true,
  skipTaskbar: true,
  frame: false,
  webPreferences: {
    // The Alarm Event window MUST share the main window's preload so the
    // renderer's `window.cookietodoAlarmAdapter` proxy exists — the
    // `AlarmEventView` Dismiss button calls `cancelAlarm(reminderId)` through
    // it. Without a preload, `contextBridge` never exposes the proxy and
    // Dismiss becomes a silent no-op (the window would never close).
    preload: join(__dirname_subst, "..", "preload", "index.cjs"),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
    autoplayPolicy: "no-user-gesture-required" as const,
  },
} as const;

/** Lazy accessor to the main window's webContents — resolved at fire time. */
export type MainWindowAccessor = () => WebContents | null;

type FiredCallback = (payload: AlarmFiredPayload) => void;

export class ElectronAlarmAdapter implements AlarmAdapter {
  private readonly timers = new Map<Reminder["id"], NodeJS.Timeout>();
  private readonly windows = new Map<Reminder["id"], BrowserWindow>();
  private readonly titles = new Map<Reminder["id"], string>();
  private readonly firedCallbacks: FiredCallback[] = [];
  /** Slice 5 hardcodes tone #1 — UI for selecting lands in a later slice. */
  private readonly soundId = 1;
  private readonly mainWindowRef: MainWindowAccessor;

  constructor(mainWindowRef: MainWindowAccessor) {
    this.mainWindowRef = mainWindowRef;
  }

  async scheduleAlarm(reminder: Reminder, todo: Todo): Promise<void> {
    // Idempotent on reminder.id — re-arm reuses the same id slot, clearing any
    // prior timer (matches the store's cancel-then-schedule flow).
    this.clearTimer(reminder.id);
    this.titles.set(reminder.id, todo.title);
    const delay = Math.max(0, reminder.triggerAt - Date.now());
    const timer = setTimeout(() => void this.fire(reminder), delay);
    // unref() so a leftover timer does not hold the main process open if the
    // user quits while one is in flight.
    timer.unref();
    this.timers.set(reminder.id, timer);
  }

  async cancelAlarm(reminderId: Reminder["id"]): Promise<void> {
    this.clearTimer(reminderId);
    this.titles.delete(reminderId);
    const win = this.windows.get(reminderId);
    if (win !== undefined && !win.isDestroyed()) {
      win.close();
    }
    this.windows.delete(reminderId);
  }

  onAlarmFired(callback: FiredCallback): () => void {
    this.firedCallbacks.push(callback);
    return () => {
      const idx = this.firedCallbacks.indexOf(callback);
      if (idx !== -1) {
        this.firedCallbacks.splice(idx, 1);
      }
    };
  }

  async requestPermission(_kind: "alarm"): Promise<"granted"> {
    return "granted";
  }

  private clearTimer(reminderId: Reminder["id"]): void {
    const t = this.timers.get(reminderId);
    if (t !== undefined) {
      clearTimeout(t);
    }
    this.timers.delete(reminderId);
  }

  private async fire(reminder: Reminder): Promise<void> {
    const soundUrl = resolveAlarmSoundUrl(this.soundId);
    const hashParams = new URLSearchParams({
      reminderId: reminder.id,
      todoId: reminder.todoId,
      soundUrl,
      soundId: String(this.soundId),
      todoTitle: this.titles.get(reminder.id) ?? "",
    });
    const hash = `#/alarm?${hashParams.toString()}`;

    const win = new BrowserWindow(ALARM_WINDOW_OPTS);
    this.windows.set(reminder.id, win);
    win.on("closed", () => {
      this.windows.delete(reminder.id);
    });

    if (isDev) {
      await win.loadURL(`${RENDERER_DEV_URL}/${hash}`);
    } else {
      await win.loadFile(RENDERER_PROD_PATH, { hash });
    }

    const payload: AlarmFiredPayload = {
      reminderId: reminder.id,
      todoId: reminder.todoId,
    };
    const mainWC = this.mainWindowRef();
    if (mainWC !== null) {
      mainWC.send("cookietodo:alarm:fired", payload);
    }
    for (const cb of this.firedCallbacks) {
      cb(payload);
    }
  }
}
