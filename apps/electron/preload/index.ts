import type {
  AlarmActionPayload,
  AlarmAdapter,
  AlarmFiredPayload,
} from "@cookietodo/renderer/alarm";
import type { DeviceAdapter } from "@cookietodo/renderer/device";
import type { Reminder, Snapshot, Todo } from "@cookietodo/renderer/domain";
import type { StoreAdapter } from "@cookietodo/renderer/persistence";
import type { SettingsAdapter } from "@cookietodo/renderer/settings";
import { contextBridge, ipcRenderer } from "electron";

/**
 * Slice-2 preload shim. Exposes a `DeviceAdapter` on the renderer's `window`
 * that proxies every method through `ipcRenderer.invoke` to the main-process
 * `safeStorage`-backed store (ADR 0009 Decision B + ADR 0010).
 *
 * Each `ipcMain.handle` channel is named `cookietodo:device:<methodName>`
 * (see `main/ipcHandlers.ts`); the preload forwards method arguments as
 * positional `ipcRenderer.invoke` args, so the main-side handler receives
 * them as `(_event, ...args)`.
 *
 * The `contextBridge` boundary strips non-serializable values, but `Promise`
 * return values are re-marshalled by Electron back to `Promise` on the
 * renderer side (no manual callback-channel plumbing needed).
 *
 * Slice 3 adds the `cookietodoStoreAdapter` window-global that proxies the 2
 * persistence channels (`loadSnapshot` / `saveSnapshot`) to the main-process
 * `ElectronStoreAdapter` (ADR 0003 + ADR 0001). The renderer's singleton
 * `cookietodoStore` reads `window.cookietodoStoreAdapter?.()` and falls back
 * to `MemoryStoreAdapter` when no preload is present (Vitest, headless Vite
 * preview) — mirrors the slice-2 `electronRendererStub` convention.
 */

const CHANNEL_PREFIX = "cookietodo:device:";
const STORE_CHANNEL_PREFIX = "cookietodo:store:";
const SETTINGS_CHANNEL_PREFIX = "cookietodo:settings:";
const ALARM_CHANNEL_PREFIX = "cookietodo:alarm:";

type Resolve<T extends (...args: never) => Promise<unknown>> = Awaited<ReturnType<T>>;

const adapter: DeviceAdapter = {
  getLocale: () =>
    ipcRenderer.invoke(`${CHANNEL_PREFIX}getLocale`) as Promise<
      Resolve<DeviceAdapter["getLocale"]>
    >,
  saveLocale: (locale) =>
    ipcRenderer.invoke(`${CHANNEL_PREFIX}saveLocale`, locale) as Promise<void>,
  getDismissPassword: () =>
    ipcRenderer.invoke(`${CHANNEL_PREFIX}getDismissPassword`) as Promise<string | null>,
  saveDismissPassword: (password) =>
    ipcRenderer.invoke(`${CHANNEL_PREFIX}saveDismissPassword`, password) as Promise<void>,
  getAlarmSoundId: () =>
    ipcRenderer.invoke(`${CHANNEL_PREFIX}getAlarmSoundId`) as Promise<
      Resolve<DeviceAdapter["getAlarmSoundId"]>
    >,
  saveAlarmSoundId: (id) =>
    ipcRenderer.invoke(`${CHANNEL_PREFIX}saveAlarmSoundId`, id) as Promise<void>,
  getWebDAVCredentials: (url) =>
    ipcRenderer.invoke(`${CHANNEL_PREFIX}getWebDAVCredentials`, url) as Promise<
      Resolve<DeviceAdapter["getWebDAVCredentials"]>
    >,
  saveWebDAVCredentials: (url, credentials) =>
    ipcRenderer.invoke(`${CHANNEL_PREFIX}saveWebDAVCredentials`, url, credentials) as Promise<void>,
};

/**
 * Store adapter proxy — only `loadSnapshot` / `saveSnapshot` are bridged
 * this slice (Import/Export wired in a later slice — see `storeHandlers.ts`).
 */
const storeAdapter: Pick<
  StoreAdapter,
  "loadSnapshot" | "saveSnapshot" | "readHistoryFile" | "appendHistoryFile"
> = {
  loadSnapshot: () =>
    ipcRenderer.invoke(`${STORE_CHANNEL_PREFIX}loadSnapshot`) as Promise<Snapshot>,
  saveSnapshot: (snapshot) =>
    ipcRenderer.invoke(`${STORE_CHANNEL_PREFIX}saveSnapshot`, snapshot) as Promise<void>,
  readHistoryFile: (filename) =>
    ipcRenderer.invoke(`${STORE_CHANNEL_PREFIX}readHistoryFile`, filename) as Promise<
      string | null
    >,
  appendHistoryFile: (filename, line) =>
    ipcRenderer.invoke(`${STORE_CHANNEL_PREFIX}appendHistoryFile`, filename, line) as Promise<void>,
};

const settingsAdapter: SettingsAdapter = {
  exportSnapshot: (snapshot) =>
    ipcRenderer.invoke(`${SETTINGS_CHANNEL_PREFIX}exportSnapshot`, snapshot) as Promise<
      string | null
    >,
  importSnapshot: () =>
    ipcRenderer.invoke(`${SETTINGS_CHANNEL_PREFIX}importSnapshot`) as Promise<Snapshot | null>,
};

/**
 * Slice-5 AlarmAdapter proxy. `scheduleAlarm` / `cancelAlarm` /
 * `requestPermission` are renderer→main `invoke` channels. `onAlarmFired`
 * wraps a `ipcRenderer.on` listener around the main→renderer push channel
 * (`cookietodo:alarm:fired`) and returns an unsubscribe — the wrap-listener
 * pattern (an explicit named function + `removeListener` on cleanup) so the
 * store's per-instance subscription can tear down without leaking the
 * listener across store reconstructions.
 *
 * Slice 6 adds `dismissAlarm` / `snoozeAlarm` invoke channels plus the
 * `onAlarmDismissed` / `onAlarmSnoozed` wrap-listeners around the
 * `cookietodo:alarm:dismissed` / `cookietodo:alarm:snoozed` push channels
 * (mirroring `onAlarmFired`).
 */
const alarmAdapter: AlarmAdapter = {
  scheduleAlarm: (reminder: Reminder, todo: Todo) =>
    ipcRenderer.invoke(`${ALARM_CHANNEL_PREFIX}scheduleAlarm`, reminder, todo) as Promise<void>,
  cancelAlarm: (reminderId: Reminder["id"]) =>
    ipcRenderer.invoke(`${ALARM_CHANNEL_PREFIX}cancelAlarm`, reminderId) as Promise<void>,
  dismissAlarm: (reminderId: Reminder["id"]) =>
    ipcRenderer.invoke(`${ALARM_CHANNEL_PREFIX}dismissAlarm`, reminderId) as Promise<void>,
  snoozeAlarm: (reminderId: Reminder["id"]) =>
    ipcRenderer.invoke(`${ALARM_CHANNEL_PREFIX}snoozeAlarm`, reminderId) as Promise<void>,
  onAlarmFired: (callback: (payload: AlarmFiredPayload) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: AlarmFiredPayload): void => {
      callback(payload);
    };
    ipcRenderer.on("cookietodo:alarm:fired", listener);
    return () => {
      ipcRenderer.removeListener("cookietodo:alarm:fired", listener);
    };
  },
  onAlarmDismissed: (callback: (payload: AlarmActionPayload) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: AlarmActionPayload): void => {
      callback(payload);
    };
    ipcRenderer.on("cookietodo:alarm:dismissed", listener);
    return () => {
      ipcRenderer.removeListener("cookietodo:alarm:dismissed", listener);
    };
  },
  onAlarmSnoozed: (callback: (payload: AlarmActionPayload) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: AlarmActionPayload): void => {
      callback(payload);
    };
    ipcRenderer.on("cookietodo:alarm:snoozed", listener);
    return () => {
      ipcRenderer.removeListener("cookietodo:alarm:snoozed", listener);
    };
  },
  requestPermission: (kind: "alarm") =>
    ipcRenderer.invoke(`${ALARM_CHANNEL_PREFIX}requestPermission`, kind) as Promise<"granted">,
};

contextBridge.exposeInMainWorld("cookietodoDeviceAdapter", () => adapter);
contextBridge.exposeInMainWorld("cookietodoStoreAdapter", () => storeAdapter);
contextBridge.exposeInMainWorld("cookietodoSettingsAdapter", () => settingsAdapter);
contextBridge.exposeInMainWorld("cookietodoAlarmAdapter", () => alarmAdapter);
