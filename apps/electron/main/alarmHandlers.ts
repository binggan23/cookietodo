/**
 * Slice 5 — Alarm IPC bridge between the sandboxed renderer preload proxy and
 * the main-process {@link ElectronAlarmAdapter}. Each {@link AlarmAdapter}
 * renderer-callable method has a matching `ipcMain.handle('cookietodo:alarm:<method>', ...)`
 * channel; the renderer-side preload forwards calls via `ipcRenderer.invoke`
 * (the canonical Electron 30 / `contextBridge` / sandboxed-renderer pattern,
 * mirroring slice-2's DeviceAdapter IPC and slice-3's StoreAdapter IPC).
 *
 * The `cookietodo:alarm:fired` channel is a MAIN→RENDERER push (not a handle):
 * `ElectronAlarmAdapter.fire()` calls `mainWindow.webContents.send(...)`, and
 * the preload's `onAlarmFired(cb)` wraps an `ipcRenderer.on` listener around
 * it (wrap-listener returning an unsubscribe). Slice 6 adds the two same-shaped
 * push channels `cookietodo:alarm:dismissed` / `cookietodo:alarm:snoozed`
 * (password-dismiss + snooze events, carrying the lighter `AlarmActionPayload`).
 *
 * Connector: `apps/electron/main/index.ts` calls
 * `registerAlarmAdapterIpc(new ElectronAlarmAdapter(getMainWindow))` AFTER
 * `registerStoreAdapterIpc(...)` and BEFORE `createWindow()` — so the
 * renderer's `window.cookietodoAlarmAdapter()` calls (fired on `App` mount +
 * on alarm save) cannot race the binding of the matching `ipcMain.handle`.
 *
 * Handler signatures match the {@link AlarmAdapter} surface 1:1 — IpcInvoke
 * args are positional `(event, ...methodArgs)`, so the first methodArg index
 * is `1`. The naming convention is `cookietodo:alarm:<methodName>`.
 */
import type { AlarmAdapter } from "@cookietodo/renderer/alarm";
import type { Reminder, Todo } from "@cookietodo/renderer/domain";
import { ipcMain } from "electron";

const CHANNEL_PREFIX = "cookietodo:alarm:";

function channelFor(
  method:
    | "scheduleAlarm"
    | "cancelAlarm"
    | "requestPermission"
    | "dismissAlarm"
    | "snoozeAlarm"
    | "closeAlarmWindow",
): string {
  return `${CHANNEL_PREFIX}${method}`;
}

/**
 * Register the 5 renderer-callable `ipcMain.handle` channels for the given
 * {@link AlarmAdapter}. `event` is the standard Electron invoke event; unused
 * (the handlers neither depend on sender nor return frame — same shape as
 * slice-2 {@link registerDeviceAdapterIpc}).
 */
export function registerAlarmAdapterIpc(adapter: AlarmAdapter): void {
  ipcMain.handle(channelFor("scheduleAlarm"), async (_event, reminder: Reminder, todo: Todo) => {
    await adapter.scheduleAlarm(reminder, todo);
  });
  ipcMain.handle(channelFor("cancelAlarm"), async (_event, reminderId: Reminder["id"]) => {
    await adapter.cancelAlarm(reminderId);
  });
  ipcMain.handle(channelFor("requestPermission"), async (_event, kind: "alarm") => {
    return adapter.requestPermission(kind);
  });
  ipcMain.handle(channelFor("dismissAlarm"), async (_event, reminderId: Reminder["id"]) => {
    await adapter.dismissAlarm(reminderId);
  });
  ipcMain.handle(channelFor("snoozeAlarm"), async (_event, reminderId: Reminder["id"]) => {
    await adapter.snoozeAlarm(reminderId);
  });
  ipcMain.handle(channelFor("closeAlarmWindow"), async (_event, reminderId: Reminder["id"]) => {
    await adapter.closeAlarmWindow(reminderId);
  });
}
