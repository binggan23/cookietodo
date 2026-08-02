/**
 * Slice 5 RED tests — store ↔ AlarmAdapter wiring (TDD red phase).
 *
 * Captured by the vitest config include glob for `tests` directory.
 *
 * Asserts the slice-5 acceptance-driven contract the store must enforce:
 *   1. `createTodo` with no reminder writes no Reminder entity + does NOT
 *      invoke `AlarmAdapter.scheduleAlarm`.
 *   2. `createTodo` with `reminderId !== null` AND `dueAt === null` is
 *      rejected by `TodoSchema.superRefine` (the slice-3 invariant — this test
 *      locks the slice-5 UI contract callback).
 *   3. `createTodo` with reminder armed AND a valid dueAt writes a Reminder
 *      entity, calls `AlarmAdapter.scheduleAlarm` with the freshly-built
 *      Reminder + Todo, and sets `Reminder.state = 'pending'`.
 *   4. `createTodo` with reminderId !== null AND `reminderTriggerAt === null`
 *      is rejected by the new `TodoInputSchema.superRefine` invariant (locks
 *      concern #2 from the Momus review).
 *   5. `createTodo` with reminderId === null AND `reminderTriggerAt !== null`
 *      is rejected by the same invariant (orphaned triggerAt).
 *   6. The store subscribes to `AlarmAdapter.onAlarmFired` once per
 *      `createCookietodoStore` factory call — when the shell pushes the fire
 *      event the store flips `Reminder.state pending → 'fired'` and the
 *      per-instance subscription produces exactly one subscriber per store
 *      (not zero, not the singleton's).
 *
 * The tests are RED now because `createCookietodoStore` takes no second
 * constructor param and `TodoInputSchema` has no `reminderTriggerAt` field —
 * the GREEN implementation lands in slice 5 Wave 3.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { createElectronAlarmStub, type ElectronAlarmStub } from "../src/alarm/electronRendererStub";
import type { Snapshot } from "../src/domain/types";
import type { StoreAdapter } from "../src/persistence/StoreAdapter";
import { createCookietodoStore, TodoInputSchema } from "../src/store/store";

/**
 * Fixed ULIDs — every `ulid()` minted in production uses the `ulid` package;
 * tests use these canonical literals so assertions can pin `reminderId` /
 * `todoId` identity without randomness. All literals pass the existing
 * `ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/` (Crockford base32 — I/L/O/U excluded).
 */
const VALID_TODOID = "01ARZ3V8EPRSWSWXN0V4K0K1TR";
const VALID_REMINDERID = "01ARZ3V8EPRSWSWXN0V4K0K1TS";

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

describe("cookietodo store — alarm wiring (slice 5)", () => {
  let harness: Harness;
  beforeEach(() => {
    harness = makeHarness();
  });

  it("createTodo without a reminder writes no Reminder entity AND does not invoke scheduleAlarm", () => {
    harness.store.getState().createTodo({
      title: "Plain",
      notes: "",
      listIds: [],
      completed: false,
      completedAt: null,
      dueAt: null,
      reminderId: null,
      reminderTriggerAt: null,
    });
    expect(harness.store.getState().snapshot.reminders).toHaveLength(0);
    expect(harness.alarmAdapter.armed.size).toBe(0);
  });

  it("createTodo with reminderId !== null AND dueAt === null is rejected by TodoInputSchema (superRefine invariant)", () => {
    // The input schema's superRefine runs on the parsed object BEFORE the
    // store's TodoSchema.parse; the store calls `TodoInputSchema.safeParse`
    // first (mirrors the slice-3 guard). For a direct throw-the-difference
    // test we use the schema directly.
    const parsed = TodoInputSchema.safeParse({
      title: "Bad",
      notes: "",
      listIds: [],
      completed: false,
      completedAt: null,
      dueAt: null,
      reminderId: VALID_REMINDERID,
      reminderTriggerAt: Date.now() + 5000,
    });
    expect(parsed.success).toBe(false);
  });

  it("createTodo with reminder armed writes Reminder entity pending + invokes scheduleAlarm with created (Reminder, Todo) pair", () => {
    const now = Date.now();
    const dueAt = now + 60_000;
    const todo = harness.store.getState().createTodo({
      title: "Walk dog",
      notes: "",
      listIds: [],
      completed: false,
      completedAt: null,
      dueAt,
      reminderId: VALID_REMINDERID,
      reminderTriggerAt: dueAt,
    });
    // Reminder entity written. Recur null per AC #8.
    const reminders = harness.store.getState().snapshot.reminders;
    expect(reminders).toHaveLength(1);
    const r = reminders[0];
    expect(r).toBeDefined();
    if (r === undefined) return; // narrows noUncheckedIndexedAccess
    expect(r.id).toBe(VALID_REMINDERID);
    expect(r.todoId).toBe(todo.id);
    expect(r.triggerAt).toBe(dueAt);
    expect(r.recur).toBeNull();
    expect(r.state).toBe("pending");
    // scheduleAlarm called with the (Reminder, Todo) pair.
    const armedReminder = harness.alarmAdapter.armed.get(VALID_REMINDERID);
    expect(armedReminder).toBeDefined();
    expect(armedReminder?.triggerAt).toBe(dueAt);
    expect(armedReminder?.state).toBe("pending");
  });

  it("TodoInputSchema rejects reminderId !== null AND reminderTriggerAt === null (orphan reminderId)", () => {
    const parsed = TodoInputSchema.safeParse({
      title: "Orphan id",
      notes: "",
      listIds: [],
      completed: false,
      completedAt: null,
      dueAt: Date.now() + 60_000,
      reminderId: VALID_REMINDERID,
      // reminderTriggerAt missing → undefined → nullability check fails.
    });
    expect(parsed.success).toBe(false);
  });

  it("TodoInputSchema rejects reminderId === null AND reminderTriggerAt !== null (orphan triggerAt)", () => {
    const parsed = TodoInputSchema.safeParse({
      title: "Orphan trigger",
      notes: "",
      listIds: [],
      completed: false,
      completedAt: null,
      dueAt: null,
      reminderId: null,
      reminderTriggerAt: Date.now() + 60_000,
    });
    expect(parsed.success).toBe(false);
  });

  it("onAlarmFired subscription per-store-instance flips Reminder.state pending → fired when shell pushes fire event", () => {
    // Per-instance subscription means: each createCookietodoStore call
    // registers exactly one subscriber against the AlarmAdapter it was
    // constructed with. Single store → single subscriber.
    const now = Date.now();
    const dueAt = now + 60_000;
    harness.store.getState().createTodo({
      title: "X",
      notes: "",
      listIds: [],
      completed: false,
      completedAt: null,
      dueAt,
      reminderId: VALID_REMINDERID,
      reminderTriggerAt: dueAt,
    });
    // The store subscribed once at construction — the stub captured it.
    expect(harness.alarmAdapter.subscribers).toHaveLength(1);
    // Simulate the shell pushing the fire event via the captured subscriber.
    const pushFire = harness.alarmAdapter.subscribers[0];
    expect(pushFire).toBeDefined();
    if (pushFire === undefined) return;
    pushFire({ reminderId: VALID_REMINDERID, todoId: VALID_TODOID });
    const r = harness.store.getState().snapshot.reminders[0];
    expect(r?.state).toBe("fired");
  });
});
