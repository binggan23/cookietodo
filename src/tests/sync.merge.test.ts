/**
 * Slice 7 — RED tests for the 3-way field-level merge engine (ADR 0004 + ADR 0006).
 *
 * This test suite is RED-first: every test will fail until `src/sync/merge.ts`
 * is implemented. Tests are organized by merge primitive (scalar-3way-LWW,
 * set-union-with-diff, monotonic-or, state-machine, cross-device-monotonic)
 * and high-level scenarios (insert-only, delete-only, modify-only, both-sides,
 * edge cases).
 *
 * Per TDD discipline, tests verify PUBLIC BEHAVIOR via the merge engine's
 * public API (`merge(local, remote, ancestor): MergeResult`), not internal
 * implementation. Tests survive refactors as long as the behavior and types
 * remain constant.
 */

import { describe, expect, it } from "vitest";
import type { List, Reminder, Snapshot, Todo } from "../src/domain/types";
import {
  IdSchema,
  ListSchema,
  ReminderSchema,
  SnapshotSchema,
  TodoSchema,
} from "../src/domain/types";
import { merge } from "../src/sync/merge";

// Test utilities
function todoFactory(overrides?: Partial<Todo>): Todo {
  const now = Date.now();
  const id = IdSchema.parse("01ARZ3V8EPRSWSWXN0V4K0K1TR");
  return TodoSchema.parse({
    id,
    title: "Test Todo",
    notes: "",
    listIds: [],
    completed: false,
    completedAt: null,
    dueAt: null,
    reminderId: null,
    createdAt: now,
    updatedAt: now,
    revision: 0,
    ...overrides,
  });
}

function _listFactory(overrides?: Partial<List>): List {
  const now = Date.now();
  const id = IdSchema.parse("01ARZ3V8EPRSWSWXN0V4K0K1TS");
  return ListSchema.parse({
    id,
    name: "Test List",
    color: null,
    createdAt: now,
    updatedAt: now,
    revision: 0,
    ...overrides,
  });
}

function reminderFactory(overrides?: Partial<Reminder>): Reminder {
  const now = Date.now();
  const id = IdSchema.parse("01ARZ3V8EPRSWSWXN0V4K0K1TT");
  const todoId = IdSchema.parse("01ARZ3V8EPRSWSWXN0V4K0K1TR");
  return ReminderSchema.parse({
    id,
    todoId,
    triggerAt: now + 60_000,
    recur: null,
    state: "pending",
    snoozedUntil: null,
    snoozeCount: 0,
    pendingPostRebootBanner: false,
    permissionRefusedAt: null,
    recurredTo: null,
    createdAt: now,
    updatedAt: now,
    revision: 0,
    ...overrides,
  });
}

function snapshotFactory(overrides?: {
  todos?: Todo[];
  lists?: List[];
  reminders?: Reminder[];
}): Snapshot {
  return SnapshotSchema.parse({
    todos: overrides?.todos ?? [],
    lists: overrides?.lists ?? [],
    reminders: overrides?.reminders ?? [],
    deleted: [],
    schemaVersion: 1,
  });
}

// ============================================================================
// TEST SUITE: Scalar 3-way LWW (Last-Write-Wins by updatedAt)
// ============================================================================

describe("merge: scalar 3-way LWW (updatedAt-based)", () => {
  const BASE_TIME = 1000;
  const EARLIER = 500;
  const LATER = 2000;

  it("LWW: both sides modify same field, remote updatedAt wins", async () => {
    const ancestorTodo = todoFactory({
      title: "Original",
      updatedAt: BASE_TIME,
    });

    const localTodo = todoFactory({
      ...ancestorTodo,
      title: "Local edit",
      updatedAt: EARLIER,
    });

    const remoteTodo = todoFactory({
      ...ancestorTodo,
      title: "Remote edit",
      updatedAt: LATER,
    });

    const local = snapshotFactory({ todos: [localTodo] });
    const remote = snapshotFactory({ todos: [remoteTodo] });
    const ancestor = snapshotFactory({ todos: [ancestorTodo] });

    const result = await merge(local, remote, ancestor);

    expect(result.merged.todos[0]?.title).toBe("Remote edit");
    expect(result.report.conflictCount).toBe(1);
  });

  it("LWW: one side modifies, other side unchanged → winner wins", async () => {
    const ancestorTodo = todoFactory({
      title: "Original",
      updatedAt: BASE_TIME,
    });

    const localTodo = todoFactory({
      ...ancestorTodo,
      title: "Local edit",
      updatedAt: LATER,
    });

    const remote = snapshotFactory({ todos: [ancestorTodo] });
    const local = snapshotFactory({ todos: [localTodo] });
    const ancestor = snapshotFactory({ todos: [ancestorTodo] });

    const result = await merge(local, remote, ancestor);

    expect(result.merged.todos[0]?.title).toBe("Local edit");
    expect(result.report.conflictCount).toBe(0);
  });

  it("LWW: both sides modify disjoint fields → both win", async () => {
    const ancestorTodo = todoFactory({
      title: "Original",
      notes: "Original notes",
      updatedAt: BASE_TIME,
    });

    const localTodo = todoFactory({
      ...ancestorTodo,
      title: "Local title",
      updatedAt: EARLIER,
    });

    const remoteTodo = todoFactory({
      ...ancestorTodo,
      notes: "Remote notes",
      updatedAt: LATER,
    });

    const local = snapshotFactory({ todos: [localTodo] });
    const remote = snapshotFactory({ todos: [remoteTodo] });
    const ancestor = snapshotFactory({ todos: [ancestorTodo] });

    const result = await merge(local, remote, ancestor);

    expect(result.merged.todos[0]?.title).toBe("Local title");
    expect(result.merged.todos[0]?.notes).toBe("Remote notes");
    expect(result.report.conflictCount).toBe(0);
  });
});

// ============================================================================
// TEST SUITE: Set union-with-diff (listIds, daysOfMonth, nthWeekday)
// ============================================================================

describe("merge: set union-with-diff", () => {
  it("set-union: both sides add different list ids → both added", async () => {
    const listA = IdSchema.parse("01ARZ3V8EPRSWSWXN0V4K0K1TA");
    const listB = IdSchema.parse("01ARZ3V8EPRSWSWXN0V4K0K1TB");

    const ancestorTodo = todoFactory({ listIds: [] });
    const localTodo = todoFactory({ ...ancestorTodo, listIds: [listA] });
    const remoteTodo = todoFactory({ ...ancestorTodo, listIds: [listB] });

    const local = snapshotFactory({ todos: [localTodo] });
    const remote = snapshotFactory({ todos: [remoteTodo] });
    const ancestor = snapshotFactory({ todos: [ancestorTodo] });

    const result = await merge(local, remote, ancestor);

    expect(result.merged.todos[0]?.listIds).toContain(listA);
    expect(result.merged.todos[0]?.listIds).toContain(listB);
    expect(result.report.conflictCount).toBe(0);
  });

  it("set-union: one side adds, other removes same id → add wins", async () => {
    const listA = IdSchema.parse("01ARZ3V8EPRSWSWXN0V4K0K1TA");

    const ancestorTodo = todoFactory({ listIds: [listA] });
    const localTodo = todoFactory({ ...ancestorTodo, listIds: [] });
    const remoteTodo = todoFactory({ ...ancestorTodo, listIds: [listA] });

    const local = snapshotFactory({ todos: [localTodo] });
    const remote = snapshotFactory({ todos: [remoteTodo] });
    const ancestor = snapshotFactory({ todos: [ancestorTodo] });

    const result = await merge(local, remote, ancestor);

    expect(result.merged.todos[0]?.listIds).toContain(listA);
    expect(result.report.conflictCount).toBe(0);
  });

  it("set-union: both sides remove same id → removed", async () => {
    const listA = IdSchema.parse("01ARZ3V8EPRSWSWXN0V4K0K1TA");

    const ancestorTodo = todoFactory({ listIds: [listA] });
    const localTodo = todoFactory({ ...ancestorTodo, listIds: [] });
    const remoteTodo = todoFactory({ ...ancestorTodo, listIds: [] });

    const local = snapshotFactory({ todos: [localTodo] });
    const remote = snapshotFactory({ todos: [remoteTodo] });
    const ancestor = snapshotFactory({ todos: [ancestorTodo] });

    const result = await merge(local, remote, ancestor);

    expect(result.merged.todos[0]?.listIds).toEqual([]);
    expect(result.report.conflictCount).toBe(0);
  });
});

// ============================================================================
// TEST SUITE: Monotonic-or for completed (true if either side true)
// ============================================================================

describe("merge: monotonic-or (completed field)", () => {
  it("monotonic-or: local completed, remote pending → merged completed", async () => {
    const now = Date.now();
    const ancestorTodo = todoFactory({
      completed: false,
      completedAt: null,
      updatedAt: 1000,
    });

    const localTodo = todoFactory({
      ...ancestorTodo,
      completed: true,
      completedAt: now,
      updatedAt: 1500,
    });

    const remoteTodo = todoFactory({
      ...ancestorTodo,
      completed: false,
      completedAt: null,
      updatedAt: 1200,
    });

    const local = snapshotFactory({ todos: [localTodo] });
    const remote = snapshotFactory({ todos: [remoteTodo] });
    const ancestor = snapshotFactory({ todos: [ancestorTodo] });

    const result = await merge(local, remote, ancestor);

    expect(result.merged.todos[0]?.completed).toBe(true);
    expect(result.merged.todos[0]?.completedAt).toBeTypeOf("number");
    expect(result.report.conflictCount).toBe(0);
  });

  it("monotonic-or: cannot regress completed to false unless both sides false AND ancestor true", async () => {
    const now = Date.now();
    const ancestorTodo = todoFactory({
      completed: true,
      completedAt: now - 10000,
      updatedAt: 1000,
    });

    const localTodo = todoFactory({
      ...ancestorTodo,
      completed: false,
      completedAt: null,
      updatedAt: 1500,
    });

    const remoteTodo = todoFactory({
      ...ancestorTodo,
      completed: false,
      completedAt: null,
      updatedAt: 1200,
    });

    const local = snapshotFactory({ todos: [localTodo] });
    const remote = snapshotFactory({ todos: [remoteTodo] });
    const ancestor = snapshotFactory({ todos: [ancestorTodo] });

    const result = await merge(local, remote, ancestor);

    expect(result.merged.todos[0]?.completed).toBe(false);
    expect(result.report.conflictCount).toBe(0);
  });

  it("monotonic-or: cannot regress if ancestor is false and one side is true", async () => {
    const now = Date.now();
    const ancestorTodo = todoFactory({
      completed: false,
      completedAt: null,
      updatedAt: 1000,
    });

    const localTodo = todoFactory({
      ...ancestorTodo,
      completed: true,
      completedAt: now,
      updatedAt: 1500,
    });

    const remoteTodo = todoFactory({
      ...ancestorTodo,
      completed: false,
      completedAt: null,
      updatedAt: 1200,
    });

    const local = snapshotFactory({ todos: [localTodo] });
    const remote = snapshotFactory({ todos: [remoteTodo] });
    const ancestor = snapshotFactory({ todos: [ancestorTodo] });

    const result = await merge(local, remote, ancestor);

    expect(result.merged.todos[0]?.completed).toBe(true);
    expect(result.report.conflictCount).toBe(0);
  });
});

// ============================================================================
// TEST SUITE: Reminder state-machine merge
// ============================================================================

describe("merge: Reminder state-machine (ADR 0006 table)", () => {
  it("state-machine: fired > pending (fired cannot regress)", async () => {
    const ancestorReminder = reminderFactory({ state: "pending" });
    const localReminder = reminderFactory({
      ...ancestorReminder,
      state: "fired",
      updatedAt: 1500,
    });
    const remoteReminder = reminderFactory({
      ...ancestorReminder,
      state: "pending",
      updatedAt: 1200,
    });

    const local = snapshotFactory({ reminders: [localReminder] });
    const remote = snapshotFactory({ reminders: [remoteReminder] });
    const ancestor = snapshotFactory({ reminders: [ancestorReminder] });

    const result = await merge(local, remote, ancestor);

    expect(result.merged.reminders[0]?.state).toBe("fired");
    expect(result.report.conflictCount).toBe(0);
  });

  it("state-machine: cleared is monotonic (only cancelled can follow)", async () => {
    const ancestorReminder = reminderFactory({ state: "pending" });
    const localReminder = reminderFactory({
      ...ancestorReminder,
      state: "cleared",
      updatedAt: 1500,
    });
    const remoteReminder = reminderFactory({
      ...ancestorReminder,
      state: "fired",
      updatedAt: 1200,
    });

    const local = snapshotFactory({ reminders: [localReminder] });
    const remote = snapshotFactory({ reminders: [remoteReminder] });
    const ancestor = snapshotFactory({ reminders: [ancestorReminder] });

    const result = await merge(local, remote, ancestor);

    expect(result.merged.reminders[0]?.state).toBe("cleared");
    expect(result.report.conflictCount).toBe(0);
  });

  it("state-machine: cancelled is terminal (wins over all)", async () => {
    const ancestorReminder = reminderFactory({ state: "pending" });
    const localReminder = reminderFactory({
      ...ancestorReminder,
      state: "cancelled",
      updatedAt: 1500,
    });
    const remoteReminder = reminderFactory({
      ...ancestorReminder,
      state: "fired",
      updatedAt: 1200,
    });

    const local = snapshotFactory({ reminders: [localReminder] });
    const remote = snapshotFactory({ reminders: [remoteReminder] });
    const ancestor = snapshotFactory({ reminders: [ancestorReminder] });

    const result = await merge(local, remote, ancestor);

    expect(result.merged.reminders[0]?.state).toBe("cancelled");
    expect(result.report.conflictCount).toBe(0);
  });
});

// ============================================================================
// TEST SUITE: Cross-device monotonic (permissionRefusedAt)
// ============================================================================

describe("merge: cross-device monotonic (permissionRefusedAt)", () => {
  it("cross-device-monotonic: any-side non-null wins both sides", async () => {
    const now = Date.now();
    const ancestorReminder = reminderFactory({
      permissionRefusedAt: null,
      updatedAt: 1000,
    });

    const localReminder = reminderFactory({
      ...ancestorReminder,
      permissionRefusedAt: now,
      updatedAt: 1500,
    });

    const remoteReminder = reminderFactory({
      ...ancestorReminder,
      permissionRefusedAt: null,
      updatedAt: 1200,
    });

    const local = snapshotFactory({ reminders: [localReminder] });
    const remote = snapshotFactory({ reminders: [remoteReminder] });
    const ancestor = snapshotFactory({ reminders: [ancestorReminder] });

    const result = await merge(local, remote, ancestor);

    expect(result.merged.reminders[0]?.permissionRefusedAt).toBe(now);
    expect(result.report.conflictCount).toBe(0);
  });

  it("cross-device-monotonic: older refusal timestamp is reset by device that refused", async () => {
    const now = Date.now();
    const oldTime = now - 86_400_000;

    const ancestorReminder = reminderFactory({
      permissionRefusedAt: oldTime,
      updatedAt: 1000,
    });

    const localReminder = reminderFactory({
      ...ancestorReminder,
      permissionRefusedAt: null,
      updatedAt: 1500,
    });

    const remoteReminder = reminderFactory({
      ...ancestorReminder,
      permissionRefusedAt: oldTime,
      updatedAt: 1200,
    });

    const local = snapshotFactory({ reminders: [localReminder] });
    const remote = snapshotFactory({ reminders: [remoteReminder] });
    const ancestor = snapshotFactory({ reminders: [ancestorReminder] });

    const result = await merge(local, remote, ancestor);

    // Local device cleared it (null); remote did not. Local is the refuser,
    // so null wins (the device that refused can clear it per ADR 0006).
    expect(result.merged.reminders[0]?.permissionRefusedAt).toBeNull();
  });
});

// ============================================================================
// TEST SUITE: Insertion-only, deletion-only, modification-only
// ============================================================================

describe("merge: insert-only, delete-only, modify-only", () => {
  it("insert-only: both sides insert different todos → both survive", async () => {
    const todoA = todoFactory({
      id: IdSchema.parse("01ARZ3V8EPRSWSWXN0V4K0K1TA"),
      title: "Todo A",
    });
    const todoB = todoFactory({
      id: IdSchema.parse("01ARZ3V8EPRSWSWXN0V4K0K1TB"),
      title: "Todo B",
    });

    const local = snapshotFactory({ todos: [todoA] });
    const remote = snapshotFactory({ todos: [todoB] });
    const ancestor = snapshotFactory({ todos: [] });

    const result = await merge(local, remote, ancestor);

    expect(result.merged.todos).toHaveLength(2);
    expect(result.merged.todos.map((t) => t.title)).toContain("Todo A");
    expect(result.merged.todos.map((t) => t.title)).toContain("Todo B");
    expect(result.report.conflictCount).toBe(0);
  });

  it("delete-only: both sides delete the same todo → deleted", async () => {
    const todoA = todoFactory({
      id: IdSchema.parse("01ARZ3V8EPRSWSWXN0V4K0K1TA"),
      title: "Todo A",
    });

    const local = snapshotFactory({ todos: [] });
    const remote = snapshotFactory({ todos: [] });
    const ancestor = snapshotFactory({ todos: [todoA] });

    const result = await merge(local, remote, ancestor);

    expect(result.merged.todos).toHaveLength(0);
    expect(result.report.conflictCount).toBe(0);
  });

  it("modify-only: one side modifies, other side leaves unchanged → modified", async () => {
    const todoA = todoFactory({
      id: IdSchema.parse("01ARZ3V8EPRSWSWXN0V4K0K1TA"),
      title: "Original",
      updatedAt: 1000,
    });

    const localTodo = todoFactory({
      ...todoA,
      title: "Modified",
      updatedAt: 1500,
    });

    const local = snapshotFactory({ todos: [localTodo] });
    const remote = snapshotFactory({ todos: [todoA] });
    const ancestor = snapshotFactory({ todos: [todoA] });

    const result = await merge(local, remote, ancestor);

    expect(result.merged.todos[0]?.title).toBe("Modified");
    expect(result.report.conflictCount).toBe(0);
  });
});

// ============================================================================
// TEST SUITE: Edge cases (delete-then-modify, no ancestor)
// ============================================================================

describe("merge: edge cases", () => {
  it("delete-then-modify: deleted on one side, modified on other → modify wins per ADR 0004", async () => {
    const todoA = todoFactory({
      id: IdSchema.parse("01ARZ3V8EPRSWSWXN0V4K0K1TA"),
      title: "Original",
      updatedAt: 1000,
    });

    const localTodo = todoFactory({
      ...todoA,
      title: "Modified",
      updatedAt: 1500,
    });

    const local = snapshotFactory({ todos: [localTodo] });
    const remote = snapshotFactory({ todos: [] });
    const ancestor = snapshotFactory({ todos: [todoA] });

    const result = await merge(local, remote, ancestor);

    // Modify wins — the item is NOT deleted
    expect(result.merged.todos).toHaveLength(1);
    expect(result.merged.todos[0]?.title).toBe("Modified");
    expect(result.report.conflictCount).toBe(0);
  });

  it("no ancestor (first sync): both sides have todos → all todos merged", async () => {
    const todoA = todoFactory({
      id: IdSchema.parse("01ARZ3V8EPRSWSWXN0V4K0K1TA"),
      title: "Local todo",
    });
    const todoB = todoFactory({
      id: IdSchema.parse("01ARZ3V8EPRSWSWXN0V4K0K1TB"),
      title: "Remote todo",
    });

    const local = snapshotFactory({ todos: [todoA] });
    const remote = snapshotFactory({ todos: [todoB] });

    const result = await merge(local, remote, null);

    expect(result.merged.todos).toHaveLength(2);
    expect(result.merged.todos.map((t) => t.title)).toContain("Local todo");
    expect(result.merged.todos.map((t) => t.title)).toContain("Remote todo");
    expect(result.report.ancestorHash).toBeNull();
  });

  it("same id inserted on both sides with different fields → both-sides-modify LWW", async () => {
    const id = IdSchema.parse("01ARZ3V8EPRSWSWXN0V4K0K1TA");

    const localTodo = todoFactory({
      id,
      title: "Local title",
      notes: "Local notes",
      updatedAt: 1500,
    });

    const remoteTodo = todoFactory({
      id,
      title: "Remote title",
      notes: "Local notes",
      updatedAt: 1200,
    });

    const local = snapshotFactory({ todos: [localTodo] });
    const remote = snapshotFactory({ todos: [remoteTodo] });

    const result = await merge(local, remote, null);

    // Local is newer on title field (LWW), so local title wins
    expect(result.merged.todos[0]?.title).toBe("Local title");
    expect(result.report.conflictCount).toBe(1);
  });
});

// ============================================================================
// TEST SUITE: Tombstone propagation
// ============================================================================

describe("merge: tombstone propagation", () => {
  it("tombstone on one side, deleted entity on other → tombstone survives", async () => {
    const todoId = IdSchema.parse("01ARZ3V8EPRSWSWXN0V4K0K1TA");
    const todo = todoFactory({ id: todoId, title: "Original" });
    const tombstone = {
      id: todoId,
      kind: "todo" as const,
      deletedAt: Date.now(),
      snapshot: todo,
    };

    const local = snapshotFactory({ todos: [], deleted: [tombstone] });
    const remote = snapshotFactory({ todos: [] });
    const ancestor = snapshotFactory({ todos: [todo] });

    const result = await merge(local, remote, ancestor);

    expect(result.merged.deleted).toHaveLength(1);
    expect(result.merged.deleted[0]?.id).toBe(todoId);
  });

  it("no tombstone, one side deletes → new tombstone created", async () => {
    const todoId = IdSchema.parse("01ARZ3V8EPRSWSWXN0V4K0K1TA");
    const todo = todoFactory({ id: todoId, title: "Original" });

    const local = snapshotFactory({ todos: [] });
    const remote = snapshotFactory({ todos: [todo] });
    const ancestor = snapshotFactory({ todos: [todo] });

    const result = await merge(local, remote, ancestor);

    // Local deleted it, remote didn't modify it. Deletion should be recorded.
    expect(result.merged.deleted).toHaveLength(1);
  });
});

// ============================================================================
// TEST SUITE: MergeReport correctness
// ============================================================================

describe("merge: MergeReport", () => {
  it("report includes localHash, remoteHash, ancestorHash", async () => {
    const local = snapshotFactory({
      todos: [todoFactory({ title: "Local" })],
    });
    const remote = snapshotFactory({
      todos: [todoFactory({ title: "Remote" })],
    });
    const ancestor = snapshotFactory({
      todos: [todoFactory({ title: "Ancestor" })],
    });

    const result = await merge(local, remote, ancestor);

    expect(result.report.localHash).toBeTypeOf("string");
    expect(result.report.remoteHash).toBeTypeOf("string");
    expect(result.report.ancestorHash).toBeTypeOf("string");
    expect(result.report.localHash).not.toBe(result.report.remoteHash);
  });

  it("report counts conflicts only on LWW field losses", async () => {
    const ancestorTodo = todoFactory({
      title: "Original",
      updatedAt: 1000,
    });

    const localTodo = todoFactory({
      ...ancestorTodo,
      title: "Local",
      updatedAt: 1500,
    });

    const remoteTodo = todoFactory({
      ...ancestorTodo,
      title: "Remote",
      updatedAt: 1200,
    });

    const local = snapshotFactory({ todos: [localTodo] });
    const remote = snapshotFactory({ todos: [remoteTodo] });
    const ancestor = snapshotFactory({ todos: [ancestorTodo] });

    const result = await merge(local, remote, ancestor);

    expect(result.report.conflictCount).toBe(1);
    expect(result.report.perEntityDiffs[ancestorTodo.id]).toBeDefined();
  });
});
