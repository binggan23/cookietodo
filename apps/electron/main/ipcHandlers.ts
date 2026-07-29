import type {
  AlarmSoundId,
  DeviceAdapter,
  Locale,
  WebDAVCredentials,
} from "@cookietodo/renderer/device";
import { ipcMain } from "electron";

/**
 * Slice-2 IPC bridge between the sandboxed renderer preload proxy and the
 * main-process {@link createDeviceStore}. Each {@link DeviceAdapter} method
 * has a matching `ipcMain.handle('cookietodo:device:<method>', ...)` channel;
 * the renderer-side preload forwards calls via `ipcRenderer.invoke` (the
 * canonical Electron 30 / `contextBridge` / sandboxed-renderer pattern).
 *
 * Handler signatures match the {@link DeviceAdapter} surface 1:1 — IpcInvoke
 * args are positional `(event, ...methodArgs)`, so the first methodArg index
 * is `1`. The naming convention is `cookietodo:device:<methodName>` so the
 * preload proxy can construct the channel name from a fixed method table.
 */
const CHANNEL_PREFIX = "cookietodo:device:";

function channelFor(method: keyof DeviceAdapter): string {
  return `${CHANNEL_PREFIX}${method}`;
}

/**
 * Register the 8 `ipcMain.handle` channels for the given {@link DeviceAdapter}.
 * `event` is the standard Electron invoke event; it's unused (the handlers
 * neither depend on sender nor return frame, and the renderer proxy reads
 * the resolved Promise value).
 */
export function registerDeviceAdapterIpc(adapter: DeviceAdapter): void {
  ipcMain.handle(channelFor("getLocale"), async () => adapter.getLocale());
  ipcMain.handle(channelFor("saveLocale"), async (_event, locale: Locale) => {
    await adapter.saveLocale(locale);
  });
  ipcMain.handle(channelFor("getDismissPassword"), async () => adapter.getDismissPassword());
  ipcMain.handle(channelFor("saveDismissPassword"), async (_event, password: string) => {
    await adapter.saveDismissPassword(password);
  });
  ipcMain.handle(channelFor("getAlarmSoundId"), async () => adapter.getAlarmSoundId());
  ipcMain.handle(channelFor("saveAlarmSoundId"), async (_event, id: AlarmSoundId) => {
    await adapter.saveAlarmSoundId(id);
  });
  ipcMain.handle(channelFor("getWebDAVCredentials"), async (_event, url: string) =>
    adapter.getWebDAVCredentials(url),
  );
  ipcMain.handle(
    channelFor("saveWebDAVCredentials"),
    async (_event, url: string, credentials: WebDAVCredentials) =>
      adapter.saveWebDAVCredentials(url, credentials),
  );
}
