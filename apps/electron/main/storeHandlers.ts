import type { Snapshot } from "@cookietodo/renderer/domain";
import type { StoreAdapter } from "@cookietodo/renderer/persistence";
import { ipcMain } from "electron";

/**
 * Slice-3 IPC bridge between the sandboxed renderer preload proxy and the
 * main-process {@link ElectronStoreAdapter}. Each {@link StoreAdapter}
 * persistence method has a matching `ipcMain.handle('cookietodo:store:<method>', ...)`
 * channel; the renderer-side preload forwards calls via
 * `ipcRenderer.invoke` (the canonical Electron 30 / `contextBridge` /
 * sandboxed-renderer pattern, mirroring slice-2's DeviceAdapter IPC).
 *
 * Connector: `apps/electron/main/index.ts` calls
 * `registerStoreAdapterIpc(new ElectronStoreAdapter())` AFTER
 * `registerDeviceAdapterIpc(...)` and BEFORE `createWindow()` — so the
 * renderer's `window.cookietodoStoreAdapter()` calls (fired on
 * `App` mount) cannot race the binding of the matching `ipcMain.handle`
 * channel on the main side.
 *
 * Handler signatures match the persistence subset of {@link StoreAdapter}:
 * `loadSnapshot` (no args) and `saveSnapshot(snapshot)`. The
 * `importSnapshot` / `exportSnapshot` methods are NOT proxied this slice —
 * they throw `not-implemented` in the adapter (Import/Export UI lands
 * later). Adding those channels in a later slice just means extending the
 * method table below; no other wiring changes.
 *
 * The naming convention is `cookietodo:store:<methodName>` so the preload
 * proxy can construct the channel name from a fixed method table — same
 * convention as slice-2's `cookietodo:device:<methodName>` for
 * {@link DeviceAdapter}.
 */
const CHANNEL_PREFIX = "cookietodo:store:";

function channelFor(
  method: "loadSnapshot" | "saveSnapshot" | "readHistoryFile" | "appendHistoryFile",
): string {
  return `${CHANNEL_PREFIX}${method}`;
}

/**
 * Register the 4 `ipcMain.handle` channels for the given {@link StoreAdapter}.
 * `event` is the Electron invoke event; it's unused (the handlers neither
 * depend on sender nor return frame, and the renderer proxy reads the
 * resolved Promise value — same shape as slice-2
 * {@link registerDeviceAdapterIpc}).
 */
export function registerStoreAdapterIpc(adapter: StoreAdapter): void {
  ipcMain.handle(channelFor("loadSnapshot"), async () => adapter.loadSnapshot());
  ipcMain.handle(channelFor("saveSnapshot"), async (_event, snapshot: Snapshot) => {
    await adapter.saveSnapshot(snapshot);
  });
  ipcMain.handle(channelFor("readHistoryFile"), async (_event, filename: string) => {
    return adapter.readHistoryFile(filename);
  });
  ipcMain.handle(
    channelFor("appendHistoryFile"),
    async (_event, filename: string, line: string) => {
      await adapter.appendHistoryFile(filename, line);
    },
  );
}
