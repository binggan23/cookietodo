/**
 * CapacitorAlarmAdapter — AlarmAdapter backed by the native
 * CookietodoAlarm plugin (AlarmManager + FullscreenAlarmActivity).
 *
 * Bridges the native plugin's notifyListeners events back to the
 * renderer's callback subscriptions. Mirrors the desktop
 * ElectronAlarmAdapter pattern.
 *
 * PUBLIC SURFACE: injected into `window.cookietodoAlarmAdapter` by the
 * Android app shell (Capacitor WebView bootstrap).
 */
import { Capacitor } from "@capacitor/core";
import type { Reminder, Todo } from "@cookietodo/renderer/domain";
import type {
  AlarmActionPayload,
  AlarmAdapter,
  AlarmFiredPayload,
} from "@cookietodo/renderer/alarm";

/**
 * Reference to the native plugin. Typed loosely because Capacitor
 * resolves it at runtime via the plugin name registered in MainActivity.
 */
const AlarmPlugin = Capacitor.Plugins.CookietodoAlarm as {
  addListener(eventName: string, callback: (data: unknown) => void): Promise<{ remove: () => void }>;
  removeAllListeners(): Promise<void>;
  schedule(options: { reminder: Record<string, unknown>; todo: Record<string, unknown> }): Promise<void>;
  cancel(options: { reminderId: string }): Promise<void>;
  dismissAlarm(options: { reminderId: string }): Promise<void>;
  snoozeAlarm(options: { reminderId: string }): Promise<void>;
  closeAlarmWindow(options: { reminderId: string }): Promise<void>;
  requestPermission(options: { kind: string }): Promise<{ result: string }>;
  onAlarmFired(): Promise<void>;
};

export class CapacitorAlarmAdapter implements AlarmAdapter {
  private listenersAttached = false;

  async scheduleAlarm(reminder: Reminder, todo: Todo): Promise<void> {
    // Serialize only the fields the native plugin needs
    const reminderData = {
      id: reminder.id,
      triggerAt: reminder.triggerAt,
      state: reminder.state,
      snoozedUntil: reminder.snoozedUntil,
      snoozeCount: reminder.snoozeCount,
    };
    const todoData = {
      id: todo.id,
      title: todo.title,
    };

    await AlarmPlugin.schedule({
      reminder: reminderData as unknown as Record<string, unknown>,
      todo: todoData as unknown as Record<string, unknown>,
    });
  }

  async cancelAlarm(reminderId: Reminder["id"]): Promise<void> {
    await AlarmPlugin.cancel({ reminderId });
  }

  async dismissAlarm(reminderId: Reminder["id"]): Promise<void> {
    await AlarmPlugin.dismissAlarm({ reminderId });
  }

  async snoozeAlarm(reminderId: Reminder["id"]): Promise<void> {
    await AlarmPlugin.snoozeAlarm({ reminderId });
  }

  async closeAlarmWindow(reminderId: Reminder["id"]): Promise<void> {
    await AlarmPlugin.closeAlarmWindow({ reminderId });
  }

  onAlarmFired(callback: (payload: AlarmFiredPayload) => void): () => void {
    this.ensureListenersAttached();

    let remove: () => void = () => {};
    AlarmPlugin.addListener("alarmFired", (data: unknown) => {
      const d = data as { reminderId?: string; todoId?: string };
      if (d.reminderId) {
        callback({ reminderId: d.reminderId, todoId: d.todoId ?? "" });
      }
    }).then((listener) => {
      remove = listener.remove;
    });

    return () => remove();
  }

  onAlarmDismissed(callback: (payload: AlarmActionPayload) => void): () => void {
    this.ensureListenersAttached();

    let remove: () => void = () => {};
    AlarmPlugin.addListener("alarmDismissed", (data: unknown) => {
      const d = data as { reminderId?: string };
      if (d.reminderId) {
        callback({ reminderId: d.reminderId });
      }
    }).then((listener) => {
      remove = listener.remove;
    });

    return () => remove();
  }

  onAlarmSnoozed(callback: (payload: AlarmActionPayload) => void): () => void {
    this.ensureListenersAttached();

    let remove: () => void = () => {};
    AlarmPlugin.addListener("alarmSnoozed", (data: unknown) => {
      const d = data as { reminderId?: string };
      if (d.reminderId) {
        callback({ reminderId: d.reminderId });
      }
    }).then((listener) => {
      remove = listener.remove;
    });

    return () => remove();
  }

  async requestPermission(_kind: "alarm"): Promise<"granted"> {
    const result = await AlarmPlugin.requestPermission({ kind: "alarm" });
    if (result.result === "granted") {
      return "granted";
    }
    // The plugin bridges to contextual-lazy permission prompts;
    // on Android, if the user denied, we still return "granted"
    // because the alarm will fire but the system may suppress
    // full-screen intent (ADR 0002 Decision B).
    return "granted";
  }

  /**
   * Ensure the plugin's listener bridge is active. This calls
   * `onAlarmFired` on the plugin so it starts bridging events
   * from FullscreenAlarmActivity to the Capacitor event system.
   */
  private ensureListenersAttached(): void {
    if (!this.listenersAttached) {
      this.listenersAttached = true;
      AlarmPlugin.onAlarmFired().catch(() => {
        // Best-effort; the plugin will still fire events through
        // FullscreenAlarmActivity directly.
      });
    }
  }
}