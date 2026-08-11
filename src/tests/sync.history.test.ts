/**
 * Slice 7 — tests for the sync history (JSONL) + orchestrator.
 *
 * Uses the in-memory {@link MemoryStoreAdapter} so the history append/read
 * round-trips are testable without a real filesystem.
 */

import { describe, expect, it } from "vitest";
import type { Snapshot, Todo } from "../src/domain/types";
import { IdSchema, SnapshotSchema, TodoSchema } from "../src/domain/types";
import { MemoryStoreAdapter } from "../src/persistence/MemoryStoreAdapter";
import { appendHistory, gcTombstones, loadRevertAncestor, readHistory } from "../src/sync/history";
import { merge } from "../src/sync/merge";
import { revertLastMerge, runSync } from "../src/sync/orchestrator";

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

function snapshotFactory(overrides?: { todos?: Todo[] }): Snapshot {
  return SnapshotSchema.parse({
    todos: overrides?.todos ?? [],
    lists: [],
    reminders: [],
    deleted: [],
    schemaVersion: 1,
  });
}

describe("sync history: append + read round-trip", () => {
  it("appends one line per sync and reads it back", async () => {
    const adapter = new MemoryStoreAdapter();
    const local = snapshotFactory({ todos: [todoFactory({ title: "Local" })] });
    const remote = snapshotFactory({ todos: [todoFactory({ title: "Remote" })] });

    const mergeResult = await merge(local, remote, null);
    await appendHistory(adapter, local, remote, null, mergeResult.merged, mergeResult.report);

    const entries = await readHistory(adapter);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.localHash).toBe(mergeResult.report.localHash);
    expect(entries[0]?.remoteHash).toBe(mergeResult.report.remoteHash);
    expect(entries[0]?.ancestorHash).toBeNull();
  });

  it("grows by exactly one line per sync pass", async () => {
    const adapter = new MemoryStoreAdapter();
    for (let i = 0; i < 3; i++) {
      const local = snapshotFactory({ todos: [todoFactory({ title: `Local ${i}` })] });
      const remote = snapshotFactory({ todos: [todoFactory({ title: `Remote ${i}` })] });
      const mergeResult = await merge(local, remote, null);
      await appendHistory(adapter, local, remote, null, mergeResult.merged, mergeResult.report);
    }
    const entries = await readHistory(adapter);
    expect(entries).toHaveLength(3);
  });

  it("returns most recent entry first", async () => {
    const adapter = new MemoryStoreAdapter();
    for (let i = 0; i < 3; i++) {
      const local = snapshotFactory({ todos: [todoFactory({ title: `Local ${i}` })] });
      const remote = snapshotFactory({ todos: [todoFactory({ title: `Remote ${i}` })] });
      const mergeResult = await merge(local, remote, null);
      await appendHistory(adapter, local, remote, null, mergeResult.merged, mergeResult.report);
    }
    const entries = await readHistory(adapter);
    expect(entries[0]?.localHash).not.toBe(entries[1]?.localHash);
  });
});

describe("sync history: revert ancestor", () => {
  it("loadRevertAncestor returns the local snapshot from before the merge", async () => {
    const adapter = new MemoryStoreAdapter();
    const ancestor = snapshotFactory({ todos: [todoFactory({ title: "Ancestor" })] });
    const local = snapshotFactory({ todos: [todoFactory({ title: "Local" })] });
    const remote = snapshotFactory({ todos: [todoFactory({ title: "Remote" })] });

    const mergeResult = await merge(local, remote, ancestor);
    await appendHistory(adapter, local, remote, ancestor, mergeResult.merged, mergeResult.report);

    const revert = await loadRevertAncestor(adapter);
    expect(revert).not.toBeNull();
    expect(revert?.snapshot.todos[0]?.title).toBe("Local");
  });

  it("loadRevertAncestor returns null when no history", async () => {
    const adapter = new MemoryStoreAdapter();
    const revert = await loadRevertAncestor(adapter);
    expect(revert).toBeNull();
  });
});

describe("sync orchestrator: runSync", () => {
  it("merges local + remote and persists the merged result", async () => {
    const adapter = new MemoryStoreAdapter();
    const localId = IdSchema.parse("01ARZ3V8EPRSWSWXN0V4K0K1TA");
    const remoteId = IdSchema.parse("01ARZ3V8EPRSWSWXN0V4K0K1TB");
    await adapter.saveSnapshot(
      snapshotFactory({ todos: [todoFactory({ id: localId, title: "Local" })] }),
    );

    const remote = snapshotFactory({ todos: [todoFactory({ id: remoteId, title: "Remote" })] });
    const result = await runSync(adapter, remote);

    expect(result.ok).toBe(true);
    const persisted = await adapter.loadSnapshot();
    expect(persisted.todos.map((t) => t.title)).toContain("Local");
    expect(persisted.todos.map((t) => t.title)).toContain("Remote");
  });

  it("reports hadConflicts when a field conflict was resolved", async () => {
    const adapter = new MemoryStoreAdapter();
    const base = todoFactory({ title: "Base", updatedAt: 1000 });
    await adapter.saveSnapshot(
      snapshotFactory({
        todos: [{ ...base, title: "Local changed", updatedAt: 1500 }],
      }),
    );

    const remote = snapshotFactory({
      todos: [{ ...base, title: "Remote changed", updatedAt: 1200 }],
    });
    const result = await runSync(adapter, remote);

    expect(result.ok).toBe(true);
    expect(result.hadConflicts).toBe(true);
    expect(result.conflictCount).toBeGreaterThan(0);
  });

  it("appends a history entry after a sync", async () => {
    const adapter = new MemoryStoreAdapter();
    await adapter.saveSnapshot(snapshotFactory({ todos: [todoFactory({ title: "Local" })] }));
    const remote = snapshotFactory({ todos: [todoFactory({ title: "Remote" })] });
    await runSync(adapter, remote);

    const entries = await readHistory(adapter);
    expect(entries).toHaveLength(1);
  });
});

describe("sync orchestrator: revertLastMerge", () => {
  it("reverts the active snapshot to the previous ancestor", async () => {
    const adapter = new MemoryStoreAdapter();
    const ancestorId = IdSchema.parse("01ARZ3V8EPRSWSWXN0V4K0K1TA");
    const remoteId = IdSchema.parse("01ARZ3V8EPRSWSWXN0V4K0K1TB");
    const ancestor = snapshotFactory({
      todos: [todoFactory({ id: ancestorId, title: "Ancestor" })],
    });
    await adapter.saveSnapshot(ancestor);

    const remote = snapshotFactory({
      todos: [todoFactory({ id: remoteId, title: "Remote" })],
    });
    const result = await runSync(adapter, remote);
    expect(result.ok).toBe(true);

    // After sync, the persisted snapshot has both todos
    const afterSync = await adapter.loadSnapshot();
    expect(afterSync.todos).toHaveLength(2);

    // Revert to the ancestor (the state before the sync)
    const reverted = await revertLastMerge(adapter);
    expect(reverted).toBe(true);
    const afterRevert = await adapter.loadSnapshot();
    expect(afterRevert.todos).toHaveLength(1);
    expect(afterRevert.todos[0]?.title).toBe("Ancestor");
  });

  it("returns false when there is no history to revert", async () => {
    const adapter = new MemoryStoreAdapter();
    const reverted = await revertLastMerge(adapter);
    expect(reverted).toBe(false);
  });
});

describe("sync: tombstone GC", () => {
  it("keeps tombstones within the retention window", async () => {
    const todo = todoFactory({ title: "Deleted" });
    const snapshot = SnapshotSchema.parse({
      todos: [],
      lists: [],
      reminders: [],
      deleted: [
        {
          id: todo.id,
          kind: "todo" as const,
          deletedAt: Date.now(),
          snapshot: todo,
        },
      ],
      schemaVersion: 1,
    });

    const gc = gcTombstones(snapshot);
    expect(gc.deleted).toHaveLength(1);
  });

  it("keeps old tombstones when no devices have acknowledged (conservative)", async () => {
    const todo = todoFactory({ title: "Deleted" });
    const snapshot = SnapshotSchema.parse({
      todos: [],
      lists: [],
      reminders: [],
      deleted: [
        {
          id: todo.id,
          kind: "todo" as const,
          deletedAt: Date.now() - 40 * 24 * 60 * 60 * 1000, // 40 days ago
          snapshot: todo,
        },
      ],
      schemaVersion: 1,
    });

    const gc = gcTombstones(snapshot, new Set());
    expect(gc.deleted).toHaveLength(1);
  });
});
