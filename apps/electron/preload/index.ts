import type { DeviceAdapter } from "@cookietodo/renderer/device";
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
 */

const CHANNEL_PREFIX = "cookietodo:device:";

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

contextBridge.exposeInMainWorld("cookietodoDeviceAdapter", () => adapter);
