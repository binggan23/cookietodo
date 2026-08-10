/**
 * In-memory {@link AlarmAdapter} stub — the renderer / Vitest headless
 * fallback when no shell-injected adapter is present on
 * `window.cookietodoAlarmAdapter` (mirrors the slice-2 `electronRendererStub`
 * pattern for {@link DeviceAdapter} and the slice-3 `MemoryStoreAdapter`
 * pattern for {@link StoreAdapter}).
 *
 * Slice 5 implements only the no-op form: `scheduleAlarm` records the latest
 * reminder so a Vitest test can introspect the signaled arming; `cancelAlarm`
 * clears the record; `onAlarmFired` registers the subscriber but never fires
 * (no shell pushes anything into this stub); `requestPermission` resolves
 * `"granted"` immediately. The Android / Electron shells pay the publisher
 * cost — the stub is the consumer-side no-op.
 *
 * Slice 6 adds the password-dismiss + snooze lifecycle: `dismissAlarm` /
 * `snoozeAlarm` record the reminderId into `dismissed` / `snoozed`;
 * `onAlarmDismissed` / `onAlarmSnoozed` register subscribers (and, like
 * `onAlarmFired`, never fire — the shells are the publishers).
 *
 * The stub is intentionally exported as a single instance (mirrors the
 * slice-2 `electronRendererStub` named-export pattern); the store's
 * singleton `cookietodoStore` does NOT need to allocate a fresh stub per
 * no-shell invocation.
 */

import type { Reminder, Todo } from "../domain/types";
import type { AlarmActionPayload, AlarmAdapter, AlarmFiredPayload } from "./AlarmAdapter";

/**
 * Returns an {@link AlarmAdapter} that records every call into the returned
 * object's `armed`, `cancelled`, `dismissed`, `snoozed`, `subscribers`,
 * `dismissedSubscribers`, `snoozedSubscribers`, and `permission` arrays so
 * callers (Vitest, optional debug logging) can introspect the no-shell fallback.
 *
 * Exported as a factory (rather than a frozen singleton) so per-test Vitest
 * stores get a fresh recorder each construction — act-of-constructing is the
 * subscription boundary per the slice-5 store design.
 */
export interface ElectronAlarmStub extends AlarmAdapter {
  /** Reminders currently marked armed — idempotent by `reminder.id`. */
  armed: Map<Reminder["id"], Reminder>;
  /** reminderIds that have been cancelled (cleared from `armed`). */
  cancelled: Reminder["id"][];
  /** reminderIds that were password-dismissed (slice 6). */
  dismissed: Reminder["id"][];
  /** reminderIds that were snoozed (slice 6). */
  snoozed: Reminder["id"][];
  /** Subscribers registered via `onAlarmFired`. */
  subscribers: Array<(payload: AlarmFiredPayload) => void>;
  /** Subscribers registered via `onAlarmDismissed`. */
  dismissedSubscribers: Array<(payload: AlarmActionPayload) => void>;
  /** Subscribers registered via `onAlarmSnoozed`. */
  snoozedSubscribers: Array<(payload: AlarmActionPayload) => void>;
  /** Recorded `requestPermission` calls. */
  permission: PermissionKindLog[];
}

interface PermissionKindLog {
  kind: "alarm";
  resolved: "granted";
}

export function createElectronAlarmStub(): ElectronAlarmStub {
  const armed = new Map<Reminder["id"], Reminder>();
  const cancelled: Reminder["id"][] = [];
  const dismissed: Reminder["id"][] = [];
  const snoozed: Reminder["id"][] = [];
  const subscribers: Array<(payload: AlarmFiredPayload) => void> = [];
  const dismissedSubscribers: Array<(payload: AlarmActionPayload) => void> = [];
  const snoozedSubscribers: Array<(payload: AlarmActionPayload) => void> = [];
  const permission: PermissionKindLog[] = [];

  return {
    armed,
    cancelled,
    dismissed,
    snoozed,
    subscribers,
    dismissedSubscribers,
    snoozedSubscribers,
    permission,
    async scheduleAlarm(reminder: Reminder, _todo: Todo): Promise<void> {
      // Idempotent on id — re-schedule overwrites the previous record keeping
      // the most-recent Reminder shape (matches the ElectronAlarmAdapter's
      // cancel-then-schedule internal contract).
      armed.set(reminder.id, reminder);
    },
    async cancelAlarm(reminderId: Reminder["id"]): Promise<void> {
      if (armed.delete(reminderId)) {
        cancelled.push(reminderId);
      }
    },
    onAlarmFired(callback: (payload: AlarmFiredPayload) => void): () => void {
      subscribers.push(callback);
      return () => {
        const idx = subscribers.indexOf(callback);
        if (idx !== -1) {
          subscribers.splice(idx, 1);
        }
      };
    },
    async dismissAlarm(reminderId: Reminder["id"]): Promise<void> {
      dismissed.push(reminderId);
    },
    async snoozeAlarm(reminderId: Reminder["id"]): Promise<void> {
      snoozed.push(reminderId);
    },
    onAlarmDismissed(callback: (payload: AlarmActionPayload) => void): () => void {
      dismissedSubscribers.push(callback);
      return () => {
        const idx = dismissedSubscribers.indexOf(callback);
        if (idx !== -1) {
          dismissedSubscribers.splice(idx, 1);
        }
      };
    },
    onAlarmSnoozed(callback: (payload: AlarmActionPayload) => void): () => void {
      snoozedSubscribers.push(callback);
      return () => {
        const idx = snoozedSubscribers.indexOf(callback);
        if (idx !== -1) {
          snoozedSubscribers.splice(idx, 1);
        }
      };
    },
    async requestPermission(kind: "alarm"): Promise<"granted"> {
      permission.push({ kind, resolved: "granted" });
      return "granted";
    },
  };
}

/**
 * Module-level singleton instance used by the renderer's singleton
 * `cookietodoStore` when no `window.cookietodoAlarmAdapter` is present
 * (Vitest, headless Vite preview, dev-tools-introspected runs).
 */
export const electronAlarmStub: ElectronAlarmStub = createElectronAlarmStub();
