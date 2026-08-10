/**
 * Slice 6 RED tests — Reminder back-compat for the two new stored fields:
 * `snoozeCount` and `pendingPostRebootBanner` (ADR 0007 Consequences — "New
 * field `snoozeCount: number` (default 0) on `Reminder`" — plus issue #7
 * AC #7, the reboot-escape flag).
 *
 * The Zod `.default()` on each field means an older Snapshot whose Reminder
 * objects lack the keys still parses, filling the defaults (ADR 0001
 * back-compat), while a newer Snapshot that carries the keys round-trips them
 * unchanged (they are ordinary strictObject fields once present).
 *
 * Tests are RED now: `ReminderSchema` has neither field, so (a) the default
 * fill never happens and (b) a snapshot that DOES carry the keys is rejected
 * by `z.strictObject` as an unknown key.
 *
 * Both snapshots are typed `unknown` at the boundary and asserted through
 * `toMatchObject` — these tests intentionally pin RUNTIME shape, not the
 * inferred TS type, so they compile identically before and after the schema
 * lands.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { createElectronAlarmStub, type ElectronAlarmStub } from "../src/alarm/electronRendererStub";
import { MAX_SNOOZES, SNOOZE_INTERVAL_MS } from "../src/alarm/snoozeConfig";
import { SnapshotSchema } from "../src/domain/schemas";
import type { Snapshot, Todo } from "../src/domain/types";
import type { StoreAdapter } from "../src/persistence/StoreAdapter";
import { createCookietodoStore } from "../src/store/store";

/**
 * Fixed ULIDs — same canonical literals as store.alarm.test.ts so any fixture
 * Reminder reuses them (Crockford base32, 26 chars, I/L/O/U excluded).
 */
const VALID_TODOID = "01ARZ3V8EPRSWSWXN0V4K0K1TR";
const VALID_REMINDERID = "01ARZ3V8EPRSWSWXN0V4K0K1TS";

/** A pre-slice-6 Reminder: every key slice 5 emitted, no `snoozeCount`. */
function preSlice6Reminder(now: number): Record<string, unknown> {
  return {
    id: VALID_REMINDERID,
    todoId: VALID_TODOID,
    triggerAt: now,
    recur: null,
    state: "pending",
    snoozedUntil: null,
    permissionRefusedAt: null,
    recurredTo: null,
    createdAt: now,
    updatedAt: now,
    revision: 0,
  };
}

describe("SnapshotSchema — slice-6 Reminder back-compat", () => {
  it("parses a pre-slice-6 Reminder (fields absent) and fills snoozeCount: 0, pendingPostRebootBanner: false", () => {
    const now = Date.now();
    const preSlice6Snapshot: unknown = {
      todos: [],
      lists: [],
      reminders: [preSlice6Reminder(now)],
      deleted: [],
      schemaVersion: 1,
    };

    const parsed = SnapshotSchema.safeParse(preSlice6Snapshot);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return; // narrows the safeParse union
    const reminder = parsed.data.reminders[0];
    expect(reminder).toBeDefined();
    if (reminder === undefined) return; // narrows noUncheckedIndexedAccess
    expect(reminder).toMatchObject({
      snoozeCount: 0,
      pendingPostRebootBanner: false,
    });
  });

  it("round-trips a slice-6 Reminder (fields present): values are preserved through parse", () => {
    const now = Date.now();
    const slice6Snapshot: unknown = {
      todos: [],
      lists: [],
      reminders: [
        {
          ...preSlice6Reminder(now),
          snoozeCount: 3,
          pendingPostRebootBanner: true,
        },
      ],
      deleted: [],
      schemaVersion: 1,
    };

    const parsed = SnapshotSchema.safeParse(slice6Snapshot);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return; // narrows the safeParse union
    const reminder = parsed.data.reminders[0];
    expect(reminder).toBeDefined();
    if (reminder === undefined) return; // narrows noUncheckedIndexedAccess
    expect(reminder).toMatchObject({
      snoozeCount: 3,
      pendingPostRebootBanner: true,
    });
  });
});

/* ======================================================================== *
 * Slice-6 lifecycle tests (Task 3) — password-dismiss, snooze-with-cap,
 * completion-clears-reminder, reboot-banner clear. RED now: the store has no
 * onAlarmDismissed / onAlarmSnoozed subscriptions, no clearReminderOnCompletion
 * path in toggleCompleted / updateTodo, and no clearRebootBanner action.
 * ======================================================================== */

function makeMemoryStoreAdapter(stub?: Partial<Snapshot>): StoreAdapter {
  let snap: Snapshot = {
    todos: [],
    lists: [],
    reminders: [],
    deleted: [],
    schemaVersion: 1,
    ...(stub ?? {}),
  };
  return {
    async loadSnapshot(): Promise<Snapshot> {
      // Defensive copy so caller mutation doesn't leak across the boundary.
      return JSON.parse(JSON.stringify(snap)) as Snapshot;
    },
    async saveSnapshot(s: Snapshot): Promise<void> {
      snap = JSON.parse(JSON.stringify(s)) as Snapshot;
    },
    async importSnapshot(): Promise<Snapshot> {
      throw new Error("not impl");
    },
    async exportSnapshot(): Promise<never> {
      throw new Error("not impl");
    },
  };
}

interface Harness {
  store: ReturnType<typeof createCookietodoStore>;
  storeAdapter: StoreAdapter;
  alarmAdapter: ElectronAlarmStub;
}

function makeHarness(): Harness {
  const storeAdapter = makeMemoryStoreAdapter();
  const alarmAdapter = createElectronAlarmStub();
  const store = createCookietodoStore(storeAdapter, alarmAdapter);
  return { store, storeAdapter, alarmAdapter };
}

/** Create an armed (pending) Todo + Reminder with the canonical ULIDs. */
function createArmedTodo(store: ReturnType<typeof createCookietodoStore>): Todo {
  const now = Date.now();
  const dueAt = now + 60_000;
  return store.getState().createTodo({
    title: "Slice6",
    notes: "",
    listIds: [],
    completed: false,
    completedAt: null,
    dueAt,
    reminderId: VALID_REMINDERID,
    reminderTriggerAt: dueAt,
  });
}

/** Push a fire event for the canonical Reminder through the stub's subscriber. */
function pushFire(alarmAdapter: ElectronAlarmStub): void {
  const fireSub = alarmAdapter.subscribers[0];
  expect(fireSub).toBeDefined();
  if (fireSub === undefined) return;
  fireSub({ reminderId: VALID_REMINDERID, todoId: VALID_TODOID });
}

/** Push a password-dismiss for the canonical Reminder. */
function pushDismiss(alarmAdapter: ElectronAlarmStub): void {
  const dismissSub = alarmAdapter.dismissedSubscribers[0];
  expect(dismissSub).toBeDefined();
  if (dismissSub === undefined) return;
  dismissSub({ reminderId: VALID_REMINDERID });
}

/** Push a snooze for the canonical Reminder. */
function pushSnooze(alarmAdapter: ElectronAlarmStub): void {
  const snoozeSub = alarmAdapter.snoozedSubscribers[0];
  expect(snoozeSub).toBeDefined();
  if (snoozeSub === undefined) return;
  snoozeSub({ reminderId: VALID_REMINDERID });
}

describe("cookietodo store — alarm lifecycle (slice 6)", () => {
  let harness: Harness;
  beforeEach(() => {
    harness = makeHarness();
  });

  it("dismiss is atomic: clears the Reminder + completes the Todo in ONE snapshot write", async () => {
    const todo = createArmedTodo(harness.store);
    expect(harness.store.getState().snapshot.reminders[0]?.state).toBe("pending");

    pushDismiss(harness.alarmAdapter);

    const state = harness.store.getState();
    expect(state.snapshot.reminders[0]?.state).toBe("cleared");
    expect(state.snapshot.reminders[0]?.pendingPostRebootBanner).toBe(false);
    expect(state.snapshot.todos[0]?.completed).toBe(true);
    const completedAt = state.snapshot.todos[0]?.completedAt;
    expect(completedAt).toBeTypeOf("number");
    // Single atomic snapshot write: the persisted image carries BOTH changes.
    const persisted = await harness.storeAdapter.loadSnapshot();
    expect(persisted.reminders[0]?.state).toBe("cleared");
    expect(persisted.todos[0]?.completed).toBe(true);
    expect(persisted.todos[0]?.completedAt).toBe(completedAt);
    expect(persisted.todos[0]?.id).toBe(todo.id);
    // Password-dismiss does not cancel the already-fired timer.
    expect(harness.alarmAdapter.cancelled).not.toContain(VALID_REMINDERID);
  });

  it("dismiss is monotonic: a second dismiss on a cleared Reminder is a no-op", () => {
    createArmedTodo(harness.store);
    pushDismiss(harness.alarmAdapter);
    const revAfterFirst = harness.store.getState().snapshot.reminders[0]?.revision;

    pushDismiss(harness.alarmAdapter);

    const state = harness.store.getState();
    expect(state.snapshot.reminders[0]?.state).toBe("cleared");
    expect(state.snapshot.reminders[0]?.revision).toBe(revAfterFirst);
    expect(state.error).toBeNull();
  });

  it("dismiss on a cancelled Reminder is a no-op (never regresses a terminal state)", () => {
    const todo = createArmedTodo(harness.store);
    // deleteTodo cascades the Reminder to 'cancelled' (terminal) while the
    // Reminder entity itself stays in the snapshot.
    harness.store.getState().deleteTodo(todo.id);
    expect(harness.store.getState().snapshot.reminders[0]?.state).toBe("cancelled");

    pushDismiss(harness.alarmAdapter);

    const state = harness.store.getState();
    expect(state.snapshot.reminders[0]?.state).toBe("cancelled");
    expect(state.error).toBeNull();
  });

  it("snooze resets pending, re-arms at now + SNOOZE_INTERVAL_MS, bumps snoozeCount", () => {
    createArmedTodo(harness.store);
    pushFire(harness.alarmAdapter);
    expect(harness.store.getState().snapshot.reminders[0]?.state).toBe("fired");

    const before = Date.now();
    pushSnooze(harness.alarmAdapter);

    const r = harness.store.getState().snapshot.reminders[0];
    expect(r?.state).toBe("pending");
    expect(r?.snoozeCount).toBe(1);
    expect(r?.snoozedUntil).toBe(r?.triggerAt);
    expect(r?.triggerAt).toBeGreaterThanOrEqual(before + SNOOZE_INTERVAL_MS);
    expect(r?.triggerAt).toBeLessThanOrEqual(before + SNOOZE_INTERVAL_MS + 5_000);
    // cancel-then-schedule: cancelled records the id, armed holds the new triggerAt.
    expect(harness.alarmAdapter.cancelled).toContain(VALID_REMINDERID);
    const armed = harness.alarmAdapter.armed.get(VALID_REMINDERID);
    expect(armed?.triggerAt).toBe(r?.triggerAt);
    expect(armed?.state).toBe("pending");
  });

  it("snooze cap: after MAX_SNOOZES the next snooze is rejected without re-arming", () => {
    createArmedTodo(harness.store);
    pushFire(harness.alarmAdapter);
    for (let i = 0; i < MAX_SNOOZES; i++) {
      pushSnooze(harness.alarmAdapter);
      expect(harness.store.getState().snapshot.reminders[0]?.snoozeCount).toBe(i + 1);
      expect(harness.store.getState().snapshot.reminders[0]?.state).toBe("pending");
    }
    const triggerAtAtCap = harness.store.getState().snapshot.reminders[0]?.triggerAt;
    const armedAtCap = harness.alarmAdapter.armed.get(VALID_REMINDERID);
    const armedTriggerAtAtCap = armedAtCap?.triggerAt;

    pushSnooze(harness.alarmAdapter);

    const state = harness.store.getState();
    expect(state.snapshot.reminders[0]?.snoozeCount).toBe(MAX_SNOOZES);
    expect(state.snapshot.reminders[0]?.triggerAt).toBe(triggerAtAtCap);
    expect(state.error).toMatch(/snooze limit reached/);
    const armedAfter = harness.alarmAdapter.armed.get(VALID_REMINDERID);
    expect(armedAfter?.triggerAt).toBe(armedTriggerAtAtCap);
  });

  it("toggleCompleted (completing) clears a fired Reminder + cancels the alarm", () => {
    const todo = createArmedTodo(harness.store);
    pushFire(harness.alarmAdapter);
    expect(harness.store.getState().snapshot.reminders[0]?.state).toBe("fired");

    harness.store.getState().toggleCompleted(todo.id);

    const state = harness.store.getState();
    expect(state.snapshot.todos[0]?.completed).toBe(true);
    expect(state.snapshot.todos[0]?.completedAt).toBeTypeOf("number");
    expect(state.snapshot.reminders[0]?.state).toBe("cleared");
    expect(state.snapshot.reminders[0]?.pendingPostRebootBanner).toBe(false);
    expect(harness.alarmAdapter.armed.has(VALID_REMINDERID)).toBe(false);
    expect(harness.alarmAdapter.cancelled).toContain(VALID_REMINDERID);
  });

  it("toggleCompleted (un-completing) leaves a cleared Reminder terminal", () => {
    const todo = createArmedTodo(harness.store);
    pushDismiss(harness.alarmAdapter);
    expect(harness.store.getState().snapshot.reminders[0]?.state).toBe("cleared");

    harness.store.getState().toggleCompleted(todo.id);

    const state = harness.store.getState();
    expect(state.snapshot.todos[0]?.completed).toBe(false);
    expect(state.snapshot.todos[0]?.completedAt).toBeNull();
    expect(state.snapshot.reminders[0]?.state).toBe("cleared");
  });

  it("clearRebootBanner dismisses a fired+flagged banner; repeat call is a no-op", () => {
    createArmedTodo(harness.store);
    pushFire(harness.alarmAdapter);
    // Manually flag the reboot-escape banner on the fired Reminder.
    const flagged: Snapshot = SnapshotSchema.parse({
      ...harness.store.getState().snapshot,
      reminders: harness.store
        .getState()
        .snapshot.reminders.map((r) =>
          r.id === VALID_REMINDERID ? { ...r, pendingPostRebootBanner: true } : r,
        ),
    });
    harness.store.getState().replaceSnapshot(flagged);
    expect(harness.store.getState().snapshot.reminders[0]?.pendingPostRebootBanner).toBe(true);

    harness.store.getState().clearRebootBanner(VALID_REMINDERID);

    const r = harness.store.getState().snapshot.reminders[0];
    expect(r?.pendingPostRebootBanner).toBe(false);
    expect(r?.state).toBe("fired");
    const revAfterClear = r?.revision;

    harness.store.getState().clearRebootBanner(VALID_REMINDERID);
    expect(harness.store.getState().snapshot.reminders[0]?.revision).toBe(revAfterClear);
    expect(harness.store.getState().error).toBeNull();
  });

  it("clearRebootBanner dismisses a pending+past-due+flagged banner (reboot-while-armed path)", () => {
    // Issue #7 AC #7 regression guard: the canonical `markRebootEscapes`
    // matcher flags a past-due `pending` Reminder too (the alarm scheduler
    // never got to fire it before shutdown, so the user elapsed it via
    // reboot). The store's dismiss guard MUST accept that branch — the
    // prior `state !== "fired"` guard silently no-op'd this case and the
    // banner stayed forever.
    const todo = createArmedTodo(harness.store);
    const beforePastDue = todo.dueAt - 60_000;
    const flagged: Snapshot = SnapshotSchema.parse({
      ...harness.store.getState().snapshot,
      reminders: harness.store.getState().snapshot.reminders.map((r) =>
        r.id === VALID_REMINDERID
          ? {
              ...r,
              state: "pending" as const,
              triggerAt: beforePastDue,
              pendingPostRebootBanner: true,
            }
          : r,
      ),
    });
    harness.store.getState().replaceSnapshot(flagged);
    expect(harness.store.getState().snapshot.reminders[0]?.state).toBe("pending");
    expect(harness.store.getState().snapshot.reminders[0]?.pendingPostRebootBanner).toBe(true);

    harness.store.getState().clearRebootBanner(VALID_REMINDERID);

    const r = harness.store.getState().snapshot.reminders[0];
    expect(r?.pendingPostRebootBanner).toBe(false);
    // State stays `pending`; clearRebootBanner only flips the banner.
    expect(r?.state).toBe("pending");
    expect(r?.triggerAt).toBe(beforePastDue);
    expect(harness.store.getState().error).toBeNull();
  });

  it("updateTodo completion clears the Reminder and does not re-arm", () => {
    const todo = createArmedTodo(harness.store);
    expect(harness.alarmAdapter.armed.get(VALID_REMINDERID)?.state).toBe("pending");

    harness.store.getState().updateTodo(todo.id, { completed: true });

    const state = harness.store.getState();
    expect(state.snapshot.todos[0]?.completed).toBe(true);
    expect(state.snapshot.reminders[0]?.state).toBe("cleared");
    expect(state.snapshot.reminders[0]?.pendingPostRebootBanner).toBe(false);
    expect(harness.alarmAdapter.armed.has(VALID_REMINDERID)).toBe(false);
    expect(harness.alarmAdapter.cancelled).toContain(VALID_REMINDERID);
  });
});
