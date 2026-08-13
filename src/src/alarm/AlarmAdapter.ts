/**
 * `AlarmAdapter` — the alarm scheduling + Alarm Event lifecycle contract
 * (ADR 0002 "must fire" Level B + ADR 0007 + ADR 0009 Decision A).
 *
 * Mirrors the slice-2/slice-3/slice-4 adapter-split pattern: a
 * renderer-visible interface (this file) and shell-specific implementations:
 *   - {@link apps/electron/main/ElectronAlarmAdapter} — desktop, Node
 *     `setTimeout` keyed to `triggerAt - Date.now()` + fullscreen `BrowserWindow`
 *     on fire (slice 5).
 *   - apps/android (Capacitor plugin, slice 10) — `AlarmManager.setExactAndAllowWhileIdle`
 *     + `setFullScreenIntent`, contextual-lazy permission request per ADR 0002 Decision B.
 *   - {@link ./electronRendererStub} — in-memory stub for Vitest / headless Vite
 *     preview when no preload is present (mirrors the slice-2 `electronRendererStub`
 *     pattern and the slice-3 `MemoryStoreAdapter`).
 *
 * Slice 6 scope (this file): the interface is shell-agnostic. Desktop returns
 * `"granted"` for `requestPermission` (alarm notifications always allowed in
 * Electron main). The Android signature is reserved; `PermissionKind` is
 * `'alarm'` only in slice 5 (the Android plugin extends `PermissionKind` in
 * slice 10).
 *
 * Slice 6 adds the password-dismiss + snooze lifecycle (ADR 0007 Decision A
 * + Decision C): `dismissAlarm` / `snoozeAlarm` close the Alarm Event from
 * the shell and push the lighter {@link AlarmActionPayload} to the renderer
 * (`cookietodo:alarm:dismissed` / `cookietodo:alarm:snoozed`); the
 * `onAlarmDismissed` / `onAlarmSnoozed` wrap-listeners mirror the
 * {@link AlarmAdapter.onAlarmFired} subscription contract.
 *
 * Every method is async because the desktop backend goes through `ipcMain.handle`
 * (renderer `ipcRenderer.invoke` through the preload proxy) and the Android
 * backend goes through the Capacitor-augmented `Window.requestPermissions` /
 * `Intent` APIs (Promise-returning). The renderer-visible `AlarmAdapter`
 * interface is async from slice 5 onward so the renderer can `await` either
 * shell shape unchanged.
 *
 * PUBLIC SURFACE: `@cookietodo/renderer/alarm`
 * (see `../../package.json` `exports` map entry).
 */
import type { Reminder, Todo } from "../domain/types";

/**
 * The kind of OS permission the Alarm Event requires before it takes over the
 * screen. Slice 5 ships only `'alarm'` (Android's `SCHEDULE_EXACT_ALARM` +
 * `USE_FULL_SCREEN_INTENT` + `SYSTEM_ALERT_WINDOW` collapse to a single
 * conceptual "alarm permission" at this layer). The Android adapter in slice 10
 * may extend to `'notification'` (Android 14 `POST_NOTIFICATIONS`).
 */
export type PermissionKind = "alarm";

/** Payload pushed from shell → renderer when an Alarm Event opens. */
export interface AlarmFiredPayload {
  /** The Reminder whose armed timer fired. */
  reminderId: Reminder["id"];
  /** The owning Todo's id (forwarded for the renderer store to locate state). */
  todoId: Todo["id"];
}

/**
 * Payload pushed from shell → renderer when the user password-dismisses or
 * snoozes an open Alarm Event (slice 6). Lighter than {@link AlarmFiredPayload}
 * — no `todoId`: the renderer store locates the owning Todo via the Reminder's
 * `todoId`, so the shell only needs to identify the Reminder.
 */
export interface AlarmActionPayload {
  /** The Reminder the user acted on (dismissed / snoozed). */
  reminderId: Reminder["id"];
}

/**
 * Alarm scheduling + Alarm Event lifecycle (ADR 0002 + ADR 0007 + ADR 0009).
 *
 * Implementation invariants:
 *   - `scheduleAlarm(reminder, todo)` is idempotent on `reminder.id`: a
 *     re-schedule with the same id cancels any previously-armed timer and
 *     arms a new one. This lets the store always cancel-then-schedule on
 *     every save with a reminder present, without tracking adapter-internal
 *     state (slice 5 e2e test below exercises this directly).
 *   - Past-due `triggerAt` (i.e. `triggerAt < Date.now()`) is NOT a failure:
 *     the desktop implementation clamps the delay to `>= 0` and fires
 *     immediately per ADR 0007; the Android implementation fires on schedule
 *     via `setExactAndAllowWhileIdle` which itself short-circuits past-due
 *     intents.
 *   - `onAlarmFired(callback)` MUST be called inside the
 *     `createCookietodoStore` factory so every store instance (singleton and
 *     per-test) subscribes to fire events. The subscription shape is a
 *     standard wrap-listener: returns a no-arg `unsubscribe` that removes
 *     the registered callback from the shell's event channel.
 */
export interface AlarmAdapter {
  /**
   * Schedule an alarm for the Reminder. On desktop the arming is a single
   * `setTimeout(triggerAt - Date.now())` clamped to `>= 0`; on fire the
   * shell opens the Alarm Event window ( BlenderWindow on desktop, full-screen
   * intent on Android) and pushes the `AlarmFiredPayload` to the renderer via
   * `onAlarmFired`.
   *
   * The `todo` is forwarded so the shell can show the Todo's title and
   * resolve the alarm-tone path on the Alarm Event window without a second
   * renderer-roundtrip; the desktop implementation in slice 5 hardcodes
   * tone #1 (default per ADR 0009 Decision A) — `DeviceAdapter.getAlarmSoundId`
   * integration lands in a later slice.
   *
   * @param reminder the Reminder entity the store has just persisted to the
   *   snapshot. The shell MUST NOT mutate this entity (it's owned by the store
   *   and was Zod-validated on the store side); it stores the fields it needs.
   * @param todo the owning Todo — forwarded for the Alarm Event UI (title) +
   *   the shell's internal logging.
   * @throws on hard failure (timer creation refused, window construction blown
   *   up) — NOT on past-due triggerAt (that fires immediately per ADR 0007).
   */
  scheduleAlarm(reminder: Reminder, todo: Todo): Promise<void>;
  /**
   * Cancel any armed timer keyed to `reminderId`. Safe call on
   * unknown / already-fired ids (no-op, NOT a hard failure) — the store calls
   * this defensively on every save path that retires a Reminder.
   *
   * Does NOT close an open Alarm Event window — that is the Dismiss button's
   * job (the renderer-side `AlarmEventView` calls `cancelAlarm` for its
   * Dismiss action in slice 5; the desktop `cancelAlarm` implementation does
   * close the window it tracks as the alarm window for that reminderId when
   * there is one open, because slice 5 dismiss is a no-state-mutation
   * placeholder per AC #5 — the state-machine stays `'fired'`).
   */
  cancelAlarm(reminderId: Reminder["id"]): Promise<void>;
  /**
   * Subscribe to Alarm Event opens pushed from the shell to the renderer.
   * Each fire produces one payload. Returns an `unsubscribe` that detaches
   * the callback from the shell's event channel so the renderer can clean up
   * on store teardown (per-instance subscriptions per the slice-5 design —
   * each `createCookietodoStore` factory call subscribes once).
   */
  onAlarmFired(callback: (payload: AlarmFiredPayload) => void): () => void;
  /**
   * Password-dismiss the Alarm Event for `reminderId` (ADR 0007 Decision A —
   * the correct 6-digit password path). The shell closes the Alarm Event
   * window and pushes a `cookietodo:alarm:dismissed` event with the
   * `{ reminderId }` payload to the main window's renderer store, then invokes
   * the registered {@link onAlarmDismissed} callbacks. Safe call on unknown /
   * already-dismissed ids (no-op, NOT a hard failure).
   */
  dismissAlarm(reminderId: Reminder["id"]): Promise<void>;
  /**
   * Snooze the Alarm Event for `reminderId` (ADR 0007 Decision A — the
   * no-password path) by the configured snooze interval (see
   * {@link ../snoozeConfig}). Same lifecycle shape as {@link dismissAlarm}:
   * closes the Alarm Event window and pushes a `cookietodo:alarm:snoozed`
   * event. Safe call on unknown / already-dismissed ids (no-op).
   */
  snoozeAlarm(reminderId: Reminder["id"]): Promise<void>;
  /**
   * Subscribe to password-dismiss events pushed from the shell to the
   * renderer. Each dismiss produces one {@link AlarmActionPayload}. Returns
   * an `unsubscribe` that detaches the callback — same wrap-listener contract
   * as {@link onAlarmFired}.
   */
  onAlarmDismissed(callback: (payload: AlarmActionPayload) => void): () => void;
  /**
   * Subscribe to snooze events pushed from the shell to the renderer. Each
   * snooze produces one {@link AlarmActionPayload}. Returns an `unsubscribe`
   * that detaches the callback — same wrap-listener contract as
   * {@link onAlarmFired}.
   */
  onAlarmSnoozed(callback: (payload: AlarmActionPayload) => void): () => void;
  /**
   * Quietly close the on-screen Alarm Event for `reminderId` and clear its
   * timer WITHOUT emitting a dismiss/snooze event (slice 8, issue #10). Used
   * when a remote sync merge flips the Reminder `fired → cleared`/`cancelled`
   * on another device — the local Alarm Event dismisses itself. Safe call on
   * unknown / already-closed ids (no-op, NOT a hard failure).
   */
  closeAlarmWindow(reminderId: Reminder["id"]): Promise<void>;
  /**
   * Request the OS-level permission needed by the Alarm Event. On desktop
   * this resolves `"granted"` immediately (alarm + notification + foreground
   * are already allowed in Electron main context per ADR 0002 phone-home path).
   * On Android (slice 10) this fires the contextual-lazy permission request
   * per ADR 0002 Decision B and resolves with `"granted"` / `"denied"` /
   * `"prompt"` (we never re-ask from this method when already denied; that
   * path lives in the dismiss-card UX per ADR 0008).
   */
  requestPermission(kind: PermissionKind): Promise<"granted">;
}

/**
 * Window-global injected by the Electron preload (slice 5) — supplies the
 * shell-appropriate {@link AlarmAdapter} (renderer IPC proxy to the
 * main-process `ElectronAlarmAdapter`). `undefined` in Vitest / headless Vite
 * preview (no preload present): the renderer's singleton store resolves to
 * the in-memory {@link electronRendererStub} in that case, mirroring the
 * slice-2 `window.cookietodoDeviceAdapter` and slice-3 `window.cookietodoStoreAdapter`
 * conventions.
 */
declare global {
  interface Window {
    cookietodoAlarmAdapter?: () => AlarmAdapter;
  }
}
