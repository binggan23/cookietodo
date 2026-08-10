/**
 * {@link markRebootEscapes} — the pure Snapshot transform behind Slice 6's
 * reboot-escape banner trigger (Issue #7 AC #7-#8, ADR 0007 "Reboot escape"
 * Consequence — "scan on next launch for Reminders whose `state === 'fired'`
 * ... whose Todo isn't completed, set `pendingPostRebootBanner: true`").
 *
 * Lives in the renderer package deliberately (no Electron / `fs` import here)
 * so Vitest can pin its behaviour. The Electron main-process wrapper at
 * {@link apps/electron/main/rebootEscape} loads `snapshot.json`, calls this
 * function, and writes it back atomically; it also hooks `will-quit` and
 * `session-end` so the flag is in place before the next launch reads it.
 *
 * Naming: "mark" instead of "set" — mark connotes a flag turned on but no
 * other state transition (state, triggerAt, snoozedUntil are all preserved
 * verbatim). The Dropout-shaped scan is the bug's whole payload — the
 * reboot escaped one or more `fired` alarms and now we surface them.
 */
import type { Reminder, Snapshot, Todo } from "../domain/types";

/**
 * Returns a new Snapshot with `pendingPostRebootBanner: true` set on every
 * Reminder that has escaped via reboot AND whose Todo is still un-completed.
 *
 * Escaped-via-reboot is here operationalised as one of:
 *   - `state === 'fired'` — the alarm fired before reboot, never got
 *     dismiss/snooze, and the Todo is still incomplete (no silent completion).
 *   - `state === 'pending'` AND `triggerAt <= now` — the alarm was armed
 *     for a moment in the past and we never saw a `fired` event for it. The
 *     restart after reboot is the next-launch window so past-due pending
 *     means the alarm's scheduler didn't get to fire before shutdown.
 *
 * Anything terminal (`cleared` / `cancelled`) is left unchanged — those
 * reminders are out of the bypass narrative (a dismissed/cancelled alarm
 * carries no pending state to escape the reboot).
 *
 * Idempotent: an already-flagged Reminder is not mutated further; the
 * returned snapshots re-uses the same Reminder object reference, so consumers
 * can detect "no change" via referential equality on a per-Reminder basis.
 *
 * CRITICAL INVARIANT: this function never advances `state`, never mutates
 * `triggerAt` / `snoozedUntil` / `snoozeCount`, and never completes a Todo.
 * The bug-from-slice-5 the reboot-escape banner repairs is that a reboot
 * silently completed a Todo by racing the alarm-cleared path; this marker is
 * the user-facing surface that says "you didn't actually dismiss this".
 */
export function markRebootEscapes(snapshot: Snapshot, now: number): Snapshot {
  // Pre-build the uncompleted-todo set — O(N) one pass, O(1) contains.
  const uncompletedTodoIds = new Set<Todo["id"]>();
  for (const todo of snapshot.todos) {
    if (!todo.completed) {
      uncompletedTodoIds.add(todo.id);
    }
  }

  // No reminders → snapshot is structurally unchanged (object identity).
  let mutated = false;
  const nextReminders: Reminder[] = [];
  for (const reminder of snapshot.reminders) {
    if (
      uncompletedTodoIds.has(reminder.todoId) &&
      reminder.pendingPostRebootBanner === false &&
      escapedViaReboot(reminder, now)
    ) {
      nextReminders.push({
        ...reminder,
        pendingPostRebootBanner: true,
      });
      mutated = true;
    } else {
      nextReminders.push(reminder);
    }
  }

  if (!mutated) {
    return snapshot;
  }

  return {
    ...snapshot,
    reminders: nextReminders,
  };
}

/**
 * Operational definition of "this Reminder escaped via reboot": state is fired
 * (alarm rang before reboot and was never dismissed), OR state is pending
 * and the trigger is already past (alarm armed for the past, scheduler did
 * not fire it, we are now on the next launch's read path).
 *
 * `cleared` and `cancelled` terminal states are not escapes — see
 * {@link markRebootEscapes} header.
 */
function escapedViaReboot(reminder: Reminder, now: number): boolean {
  if (reminder.state === "fired") return true;
  if (reminder.state === "pending" && reminder.triggerAt <= now) return true;
  return false;
}
