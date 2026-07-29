import { contextBridge } from "electron";

/**
 * Slice-1 preload shim.
 *
 * Slice 1's renderer-side `DeviceAdapter` stub (`@cookietodo/renderer` ->
 * `electronRendererStub`) backs onto `localStorage` and does NOT need to be
 * injected by the preload — the renderer falls back to it when
 * `window.cookietodoDeviceAdapter` is undefined (see App.tsx).
 *
 * Slice 2 swaps this stub for a `safeStorage`-backed adapter injected here via
 * `contextBridge.exposeInMainWorld("cookietodoDeviceAdapter", () => adapter)`
 * where `adapter` is constructed in the main process and IPC'd into the
 * renderer through the preload. The shape of `DeviceAdapter` does not change
 * (ADR 0009 + ADR 0010 surface stays stable across slice 2).
 *
 * We still expose a no-op island today so the renderer's `window.cookietodoDeviceAdapter`
 * lookup stays a stable contract — `undefined` is the explicit "renderer-stub
 * in use" signal. (Removing the no-op would require the renderer to special-case
 * the missing global on every read.)
 */
contextBridge.exposeInMainWorld("cookietodoDeviceAdapterIsolated", { ready: true });
