/**
 * Slice 6 — reboot-escape banner trigger logic (Issue #7 AC #7-#8, ADR 0007
 * "Reboot escape" Consequence — "scan on next launch for Reminders whose
 * `state === 'fired'` ... whose Todo isn't completed, set
 * `pendingPostRebootBanner: true`").
 *
 * The pure transform lives in {@link src/src/persistence/markRebootEscapes}
 * — separated from {@link apps/electron/main/rebootEscape} because the
 * matcher reads only the in-memory Snapshot (no Electron); the Electron
 * side wires `will-quit` + `session-end` to call it against the on-disk
 * snapshot.json. Testing the matcher here keeps the fs/Electron cargo at the
 * door — it is the failure the bug ships through.
 *
 * RED when first written — `src/src/persistence/markRebootEscapes` does not
 * exist yet.
 */
import { describe, expect, it } from "vitest";
import { SnapshotSchema } from "../src/domain/schemas";
import type { Reminder, Snapshot, Todo } from "../src/domain/types";
import { markRebootEscapes } from "../src/persistence/markRebootEscapes";

const TODOID = "01ARZ3V8EPRSWSWXN0V4K0K1TR";
const REMINDERID = "01ARZ3V8EPRSWSWXN0V4K0K1TS";
const NOW = 1_700_000_000_000;

function makeTodo(completed: boolean): Todo {
  return SnapshotSchema.parse({
    todos: [
      {
        id: TODOID,
        title: "slice6",
        notes: "",
        listIds: [],
        completed,
        completedAt: completed ? NOW : null,
        dueAt: NOW - 60_000,
        reminderId: REMINDERID,
        createdAt: NOW - 120_000,
        updatedAt: NOW - 120_000,
        revision: 0,
      },
    ],
    lists: [],
    reminders: [],
  }).todos[0] as Todo;
}

function makeReminder(state: Reminder["state"], triggerAt: number, banner = false): Reminder {
  const parsed = SnapshotSchema.parse({
    todos: [],
    lists: [],
    reminders: [
      {
        id: REMINDERID,
        todoId: TODOID,
        triggerAt,
        recur: null,
        state,
        snoozedUntil: null,
        snoozeCount: 0,
        pendingPostRebootBanner: banner,
        permissionRefusedAt: null,
        recurredTo: null,
        createdAt: NOW - 120_000,
        updatedAt: NOW - 1_000,
        revision: 0,
      },
    ],
    deleted: [],
    schemaVersion: 1,
  });
  return parsed.reminders[0] as Reminder;
}

function snapshotOf(todo: Todo, reminder: Reminder): Snapshot {
  return SnapshotSchema.parse({
    todos: [todo],
    lists: [],
    reminders: [reminder],
    deleted: [],
    schemaVersion: 1,
  });
}

describe("markRebootEscapes — the pure matcher", () => {
  it("flags a `fired` Reminder joined to an uncompleted Todo; state stays `fired` (no silent completion)", () => {
    const snap = snapshotOf(makeTodo(false), makeReminder("fired", NOW));
    expect(snap.reminders[0]?.pendingPostRebootBanner).toBe(false);

    const next = markRebootEscapes(snap, NOW);

    expect(next.reminders[0]?.pendingPostRebootBanner).toBe(true);
    // CRITICAL: state does NOT regress. The whole point of AC #7 is the
    // reboot event must NOT silently complete — the Reminder stays `fired`
    // (it does NOT silently advance to `cleared`) and the Todo stays
    // un-completed.
    expect(next.reminders[0]?.state).toBe("fired");
    expect(next.todos[0]?.completed).toBe(false);
    expect(next.todos[0]?.completedAt).toBeNull();
  });

  it("flags a past-due `pending` Reminder joined to an uncompleted Todo; state stays `pending` (escaped before firing)", () => {
    const dueInPast = NOW - 10_000;
    const snap = snapshotOf(makeTodo(false), makeReminder("pending", dueInPast));

    const next = markRebootEscapes(snap, NOW);

    expect(next.reminders[0]?.pendingPostRebootBanner).toBe(true);
    expect(next.reminders[0]?.state).toBe("pending");
    expect(next.reminders[0]?.triggerAt).toBe(dueInPast);
    expect(next.todos[0]?.completed).toBe(false);
  });

  it("does not flag a `fired` Reminder whose Todo is already completed (dismiss-as-complete already cleared the alarm)", () => {
    const snap = snapshotOf(makeTodo(true), makeReminder("fired", NOW));

    const next = markRebootEscapes(snap, NOW);

    expect(next.reminders[0]?.pendingPostRebootBanner).toBe(false);
  });

  it("does not flag a future `pending` Reminder joined to an uncompleted Todo (not yet past-due — not a reboot escape)", () => {
    const dueInFuture = NOW + 5_000;
    const snap = snapshotOf(makeTodo(false), makeReminder("pending", dueInFuture));

    const next = markRebootEscapes(snap, NOW);

    expect(next.reminders[0]?.pendingPostRebootBanner).toBe(false);
    expect(next.reminders[0]?.state).toBe("pending");
  });

  it("does not double-flag an already-bannered Reminder (idempotent; reminders array unchanged structurally)", () => {
    const raw = makeReminder("fired", NOW, true);
    const snap = snapshotOf(makeTodo(false), raw);
    const pre = snap.reminders[0];
    expect(pre?.pendingPostRebootBanner).toBe(true);

    const next = markRebootEscapes(snap, NOW);

    expect(next.reminders[0]?.pendingPostRebootBanner).toBe(true);
    // No-op — the Reminder reference is unchanged (referential equality on
    // the unmodified Reminder object; the snapshot copy still replaced the
    // array but the element IS the same object).
    expect(next.reminders[0]).toBe(pre);
  });

  it("leaves a `cleared` / `cancelled` Reminder untouched (terminal-state reminders are out of the bypass narrative)", () => {
    for (const state of ["cleared", "cancelled"] as const) {
      const snap = snapshotOf(makeTodo(false), makeReminder(state, NOW));
      const next = markRebootEscapes(snap, NOW);
      expect(next.reminders[0]?.pendingPostRebootBanner).toBe(false);
      expect(next.reminders[0]?.state).toBe(state);
    }
  });
});
