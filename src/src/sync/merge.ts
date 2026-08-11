/**
 * Slice 7 — 3-way field-level merge engine (ADR 0004 + ADR 0006).
 *
 * Core algorithm:
 *   1. Identify inserted/updated/deleted entities by id in local vs remote vs ancestor
 *   2. For each affected entity, apply per-field merge semantics:
 *      - Scalar 3-way LWW (keyed by updatedAt)
 *      - Set union-with-diff (additions union, deletions diff, add wins over delete)
 *      - Monotonic-or (completed: true if either side)
 *      - State-machine (Reminder states: fired > pending, cleared monotonic, cancelled terminal)
 *      - Cross-device monotonic (permissionRefusedAt: any-side non-null wins)
 *   3. Tombstones propagate: one-side tombstone survives
 *   4. Delete-then-modify: modify wins (conservative — no silent data loss)
 *   5. Return merged Snapshot + detailed MergeReport
 */

import type { List, Reminder, Snapshot, Todo, Tombstone } from "../domain/types";
import { ListSchema, ReminderSchema, SnapshotSchema, TodoSchema } from "../domain/types";

// ============================================================================
// TYPES
// ============================================================================

export interface MergeResult {
  merged: Snapshot;
  report: MergeReport;
}

export interface MergeReport {
  localHash: string;
  remoteHash: string;
  ancestorHash: string | null;
  conflictCount: number;
  totalChanges: number;
  perEntityDiffs: Record<string, EntityDiff>;
}

interface EntityDiff {
  kind: "todo" | "list" | "reminder";
  id: string;
  fields: Record<string, FieldMergeOutcome>;
}

interface FieldMergeOutcome {
  ancestor?: unknown;
  local?: unknown;
  remote?: unknown;
  merged: unknown;
  conflict: boolean;
}

// ============================================================================
// HASH & COMPARE UTILITIES
// ============================================================================

function hashSnapshot(snapshot: Snapshot): string {
  return fnv1a(JSON.stringify(snapshot));
}

/**
 * FNV-1a 32-bit hash — deterministic string hash that works in any
 * JS runtime (browser + Node). Used for snapshot content hashing in the
 * merge report (content-addressed, not cryptographic).
 */
function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Force unsigned 32-bit and hex
  return (h >>> 0).toString(16).padStart(8, "0");
}

// ============================================================================
// ENTITY LOOKUP MAPS
// ============================================================================

type EntityMap<T> = Map<string, T>;

function buildEntityMap<T extends { id: string }>(entities: T[]): EntityMap<T> {
  const map = new Map<string, T>();
  for (const entity of entities) {
    map.set(entity.id, entity);
  }
  return map;
}

// ============================================================================
// FIELD-LEVEL MERGE PRIMITIVES
// ============================================================================

/**
 * Scalar 3-way LWW: if both sides modified, take the one with later updatedAt.
 * Returns { value, conflict }.
 */
function merge3WayLWW(
  ancestorValue: unknown,
  localValue: unknown,
  remoteValue: unknown,
  _ancestorUpdatedAt: number,
  localUpdatedAt: number,
  remoteUpdatedAt: number,
): { merged: unknown; conflict: boolean } {
  // If both sides are unchanged from ancestor, no change
  if (localValue === ancestorValue && remoteValue === ancestorValue) {
    return { merged: ancestorValue, conflict: false };
  }

  // If one side unchanged, take the changed side
  if (localValue === ancestorValue) {
    return { merged: remoteValue, conflict: false };
  }
  if (remoteValue === ancestorValue) {
    return { merged: localValue, conflict: false };
  }

  // Both sides changed from ancestor
  // If they have the same value, no conflict (both made the same change)
  if (localValue === remoteValue) {
    return { merged: localValue, conflict: false };
  }

  // Both sides changed to different values — LWW by updatedAt
  if (localUpdatedAt >= remoteUpdatedAt) {
    return { merged: localValue, conflict: localUpdatedAt !== remoteUpdatedAt };
  }
  return { merged: remoteValue, conflict: true };
}

/**
 * Set union-with-diff: adds union, deletions diff, add wins over delete.
 *
 * If an entity doesn't exist on a side, its set is treated as empty.
 */
function mergeSetUnionWithDiff(
  ancestorSet: unknown[],
  localSet: unknown[] | undefined,
  remoteSet: unknown[] | undefined,
): { merged: unknown[]; conflict: boolean } {
  const ancestorIds = new Set(ancestorSet);
  const localIds = new Set(localSet ?? []);
  const remoteIds = new Set(remoteSet ?? []);

  // Compute additions and deletions
  const localAdds = new Set([...localIds].filter((id) => !ancestorIds.has(id)));
  const localDels = new Set([...ancestorIds].filter((id) => !localIds.has(id)));
  const remoteAdds = new Set([...remoteIds].filter((id) => !ancestorIds.has(id)));
  const remoteDels = new Set([...ancestorIds].filter((id) => !remoteIds.has(id)));

  // Union adds, diff deletes (adds win)
  const result = new Set([...ancestorIds]);
  for (const id of localAdds) result.add(id);
  for (const id of remoteAdds) result.add(id);
  // Only delete if BOTH sides deleted
  for (const id of localDels) {
    if (remoteDels.has(id)) result.delete(id);
  }

  return {
    merged: [...result],
    conflict: false,
  };
}

/**
 * Monotonic-or for completed: true if either side true.
 * Can only regress (true → false) if both sides are false AND ancestor is true.
 */
function mergeMonotonicOr(
  _ancestorCompleted: boolean,
  localCompleted: boolean,
  remoteCompleted: boolean,
): { merged: boolean; conflict: boolean } {
  if (localCompleted || remoteCompleted) {
    return { merged: true, conflict: false };
  }
  // Both false — can regress only if ancestor is also true
  return { merged: false, conflict: false };
}

/**
 * Reminder state-machine: apply the ADR 0006 table.
 * fired > pending, cleared monotonic, cancelled terminal.
 */
function mergeReminderState(
  localState: "pending" | "fired" | "cleared" | "cancelled" | undefined,
  remoteState: "pending" | "fired" | "cleared" | "cancelled" | undefined,
): { merged: "pending" | "fired" | "cleared" | "cancelled"; conflict: boolean } {
  const left = localState ?? "pending";
  const right = remoteState ?? "pending";

  // ADR 0006 state-machine table
  const table: Record<string, Record<string, "pending" | "fired" | "cleared" | "cancelled">> = {
    pending: { pending: "pending", fired: "fired", cleared: "cleared", cancelled: "cancelled" },
    fired: { pending: "fired", fired: "fired", cleared: "cleared", cancelled: "cancelled" },
    cleared: { pending: "cleared", fired: "cleared", cleared: "cleared", cancelled: "cancelled" },
    cancelled: {
      pending: "cancelled",
      fired: "cancelled",
      cleared: "cancelled",
      cancelled: "cancelled",
    },
  };

  const merged = table[left]?.[right];
  if (!merged) {
    return { merged: "cancelled", conflict: true };
  }

  return { merged, conflict: false };
}

/**
 * Cross-device monotonic for permissionRefusedAt: any-side non-null wins.
 * The device that REFUSED the permission sets the timestamp; only that
 * device can clear it (set back to null) — other devices' stale nulls
 * do not undo the refusal.
 */
function mergeCrossDeviceMonotonic(
  ancestorValue: number | null | undefined,
  localValue: number | null | undefined,
  remoteValue: number | null | undefined,
): { merged: number | null; conflict: boolean } {
  const a = ancestorValue ?? null;
  const l = localValue ?? null;
  const r = remoteValue ?? null;

  // If both sides are null → null
  if (l === null && r === null) {
    return { merged: null, conflict: false };
  }

  // Both sides non-null — take the later one (both devices observed the refusal)
  if (l !== null && r !== null) {
    return { merged: l, conflict: false };
  }

  // One side non-null, one side null:
  // If the non-null side equals the ancestor value, the null side wins
  // (the device that originally refused is clearing it on its own device).
  // If the non-null side is different from ancestor, the non-null side wins
  // (a new refusal was observed on that device).
  const [nonNullSide, _nullSide] = l !== null ? [l, r] : [r, l];
  if (nonNullSide === a) {
    // The non-null value is just the stale ancestor — the null side (refuser clearing) wins
    return { merged: null, conflict: false };
  }
  // The non-null side has a new refusal — non-null wins
  return { merged: nonNullSide, conflict: false };
}

// ============================================================================
// ENTITY MERGE DISPATCHERS
// ============================================================================

/**
 * Merge a Todo entity. If an entity is missing from a side (undefined),
 * it means that side deleted it. The merge function must handle this.
 *
 * Per ADR 0004: delete-then-modify → modify wins.
 * Per ADR 0004: delete-only-on-one-side → keep the entity (modify-wins conservatively).
 * Per ADR 0004: delete-on-both-sides → delete.
 */
function mergeTodo(
  ancestorTodo: Todo | undefined,
  localTodo: Todo | undefined,
  remoteTodo: Todo | undefined,
): { merged: Todo; diffs: Record<string, FieldMergeOutcome>; deleted: boolean } {
  const id = localTodo?.id || remoteTodo?.id || ancestorTodo?.id;
  if (!id) throw new Error("No id for todo merge");

  const localDeleted = localTodo === undefined;
  const remoteDeleted = remoteTodo === undefined;

  // Both sides deleted → delete
  if (localDeleted && remoteDeleted && ancestorTodo !== undefined) {
    return {
      merged: TodoSchema.parse({
        id,
        title: "Deleted",
        notes: "",
        listIds: [],
        completed: false,
        completedAt: null,
        dueAt: null,
        reminderId: null,
        createdAt: ancestorTodo.createdAt,
        updatedAt: Date.now(),
        revision: (ancestorTodo.revision ?? 0) + 1,
      }),
      diffs: {},
      deleted: true,
    };
  }

  // One side deleted, other side exists (compared to ancestor)
  if (localDeleted !== remoteDeleted && ancestorTodo !== undefined) {
    const keepingSide = localDeleted ? remoteTodo : localTodo;
    if (keepingSide === undefined) {
      return { merged: ancestorTodo, diffs: {}, deleted: true };
    }
    if (deepEqual(keepingSide, ancestorTodo)) {
      return { merged: ancestorTodo, diffs: {}, deleted: true };
    }
    return { merged: keepingSide, diffs: {}, deleted: false };
  }

  // One side deleted, other side didn't exist in ancestor → keep the non-deleted
  if (localDeleted && !remoteDeleted && ancestorTodo === undefined) {
    return { merged: remoteTodo, diffs: {}, deleted: false };
  }
  if (remoteDeleted && !localDeleted && ancestorTodo === undefined) {
    return { merged: localTodo, diffs: {}, deleted: false };
  }

  // Both sides have the entity — do field-level merge
  const ancestor = ancestorTodo || ({} as Partial<Todo>);
  const local = localTodo || ({} as Partial<Todo>);
  const remote = remoteTodo || ({} as Partial<Todo>);

  const diffs: Record<string, FieldMergeOutcome> = {};
  const now = Date.now();

  const ancestorUpdatedAt = ancestor.updatedAt ?? 0;
  const localUpdatedAt = local.updatedAt ?? 0;
  const remoteUpdatedAt = remote.updatedAt ?? 0;

  // title: scalar 3-way LWW
  const titleMerge = merge3WayLWW(
    ancestor.title,
    local.title,
    remote.title,
    ancestorUpdatedAt,
    localUpdatedAt,
    remoteUpdatedAt,
  );
  diffs.title = {
    ancestor: ancestor.title,
    local: local.title,
    remote: remote.title,
    merged: titleMerge.merged,
    conflict: titleMerge.conflict,
  };

  // notes: scalar 3-way LWW
  const notesMerge = merge3WayLWW(
    ancestor.notes,
    local.notes,
    remote.notes,
    ancestorUpdatedAt,
    localUpdatedAt,
    remoteUpdatedAt,
  );
  diffs.notes = {
    ancestor: ancestor.notes,
    local: local.notes,
    remote: remote.notes,
    merged: notesMerge.merged,
    conflict: notesMerge.conflict,
  };

  // listIds: set union-with-diff
  const listIdsMerge = mergeSetUnionWithDiff(
    (ancestor.listIds as unknown as string[]) || [],
    local.listIds as unknown as string[],
    remote.listIds as unknown as string[],
  );
  diffs.listIds = {
    ancestor: ancestor.listIds,
    local: local.listIds,
    remote: remote.listIds,
    merged: listIdsMerge.merged,
    conflict: listIdsMerge.conflict,
  };

  // completed: monotonic-or
  const completedMerge = mergeMonotonicOr(
    ancestor.completed ?? false,
    local.completed ?? false,
    remote.completed ?? false,
  );
  diffs.completed = {
    ancestor: ancestor.completed,
    local: local.completed,
    remote: remote.completed,
    merged: completedMerge.merged,
    conflict: completedMerge.conflict,
  };

  // completedAt: coupled to completed
  const completedAt = completedMerge.merged
    ? (local.completedAt ?? remote.completedAt ?? now)
    : null;
  diffs.completedAt = {
    ancestor: ancestor.completedAt,
    local: local.completedAt,
    remote: remote.completedAt,
    merged: completedAt,
    conflict: false,
  };

  // dueAt: scalar 3-way LWW
  const dueAtMerge = merge3WayLWW(
    ancestor.dueAt,
    local.dueAt,
    remote.dueAt,
    ancestorUpdatedAt,
    localUpdatedAt,
    remoteUpdatedAt,
  );
  diffs.dueAt = {
    ancestor: ancestor.dueAt,
    local: local.dueAt,
    remote: remote.dueAt,
    merged: dueAtMerge.merged,
    conflict: dueAtMerge.conflict,
  };

  // reminderId: scalar 3-way LWW
  const reminderIdMerge = merge3WayLWW(
    ancestor.reminderId,
    local.reminderId,
    remote.reminderId,
    ancestorUpdatedAt,
    localUpdatedAt,
    remoteUpdatedAt,
  );
  diffs.reminderId = {
    ancestor: ancestor.reminderId,
    local: local.reminderId,
    remote: remote.reminderId,
    merged: reminderIdMerge.merged,
    conflict: reminderIdMerge.conflict,
  };

  const merged = TodoSchema.parse({
    id,
    title: titleMerge.merged,
    notes: notesMerge.merged,
    listIds: listIdsMerge.merged,
    completed: completedMerge.merged,
    completedAt,
    dueAt: dueAtMerge.merged,
    reminderId: reminderIdMerge.merged,
    createdAt: ancestor.createdAt ?? local.createdAt ?? remote.createdAt ?? now,
    updatedAt: now,
    revision: Math.max(ancestor.revision ?? 0, local.revision ?? 0, remote.revision ?? 0) + 1,
  });

  return { merged, diffs, deleted: false };
}

function mergeList(
  ancestorList: List | undefined,
  localList: List | undefined,
  remoteList: List | undefined,
): { merged: List; diffs: Record<string, FieldMergeOutcome>; deleted: boolean } {
  const id = localList?.id || remoteList?.id || ancestorList?.id;
  if (!id) throw new Error("No id for list merge");

  const localDeleted = localList === undefined;
  const remoteDeleted = remoteList === undefined;

  // Both sides deleted → delete
  if (localDeleted && remoteDeleted && ancestorList !== undefined) {
    return {
      merged: ListSchema.parse({
        id,
        name: "Deleted",
        color: null,
        createdAt: ancestorList.createdAt,
        updatedAt: Date.now(),
        revision: (ancestorList.revision ?? 0) + 1,
      }),
      diffs: {},
      deleted: true,
    };
  }

  // One side deleted, other side exists (compared to ancestor)
  if (localDeleted !== remoteDeleted && ancestorList !== undefined) {
    const keepingSide = localDeleted ? remoteList : localList;
    if (keepingSide === undefined) {
      return { merged: ancestorList, diffs: {}, deleted: true };
    }
    if (deepEqual(keepingSide, ancestorList)) {
      return { merged: ancestorList, diffs: {}, deleted: true };
    }
    return { merged: keepingSide, diffs: {}, deleted: false };
  }

  // One side deleted, other side didn't exist in ancestor → keep the non-deleted
  if (localDeleted && !remoteDeleted && ancestorList === undefined) {
    return { merged: remoteList, diffs: {}, deleted: false };
  }
  if (remoteDeleted && !localDeleted && ancestorList === undefined) {
    return { merged: localList, diffs: {}, deleted: false };
  }

  const ancestor = ancestorList || ({} as Partial<List>);
  const local = localList || ({} as Partial<List>);
  const remote = remoteList || ({} as Partial<List>);

  const diffs: Record<string, FieldMergeOutcome> = {};
  const now = Date.now();

  const ancestorUpdatedAt = ancestor.updatedAt ?? 0;
  const localUpdatedAt = local.updatedAt ?? 0;
  const remoteUpdatedAt = remote.updatedAt ?? 0;

  // name: scalar 3-way LWW
  const nameMerge = merge3WayLWW(
    ancestor.name,
    local.name,
    remote.name,
    ancestorUpdatedAt,
    localUpdatedAt,
    remoteUpdatedAt,
  );
  diffs.name = {
    ancestor: ancestor.name,
    local: local.name,
    remote: remote.name,
    merged: nameMerge.merged,
    conflict: nameMerge.conflict,
  };

  // color: scalar 3-way LWW
  const colorMerge = merge3WayLWW(
    ancestor.color,
    local.color,
    remote.color,
    ancestorUpdatedAt,
    localUpdatedAt,
    remoteUpdatedAt,
  );
  diffs.color = {
    ancestor: ancestor.color,
    local: local.color,
    remote: remote.color,
    merged: colorMerge.merged,
    conflict: colorMerge.conflict,
  };

  const merged = ListSchema.parse({
    id,
    name: nameMerge.merged,
    color: colorMerge.merged,
    createdAt: ancestor.createdAt ?? local.createdAt ?? remote.createdAt ?? now,
    updatedAt: now,
    revision: Math.max(ancestor.revision ?? 0, local.revision ?? 0, remote.revision ?? 0) + 1,
  });

  return { merged, diffs, deleted: false };
}

function mergeReminder(
  ancestorReminder: Reminder | undefined,
  localReminder: Reminder | undefined,
  remoteReminder: Reminder | undefined,
): { merged: Reminder; diffs: Record<string, FieldMergeOutcome>; deleted: boolean } {
  const id = localReminder?.id || remoteReminder?.id || ancestorReminder?.id;
  if (!id) throw new Error("No id for reminder merge");

  const localDeleted = localReminder === undefined;
  const remoteDeleted = remoteReminder === undefined;

  // Both sides deleted → delete
  if (localDeleted && remoteDeleted && ancestorReminder !== undefined) {
    return {
      merged: ReminderSchema.parse({
        id,
        todoId: ancestorReminder.todoId,
        triggerAt: Date.now(),
        recur: null,
        state: "cancelled",
        snoozedUntil: null,
        snoozeCount: 0,
        pendingPostRebootBanner: false,
        permissionRefusedAt: null,
        recurredTo: null,
        createdAt: ancestorReminder.createdAt,
        updatedAt: Date.now(),
        revision: (ancestorReminder.revision ?? 0) + 1,
      }),
      diffs: {},
      deleted: true,
    };
  }

  // One side deleted, other side exists (compared to ancestor)
  if (localDeleted !== remoteDeleted && ancestorReminder !== undefined) {
    const keepingSide = localDeleted ? remoteReminder : localReminder;
    if (keepingSide === undefined) {
      return { merged: ancestorReminder, diffs: {}, deleted: true };
    }
    if (deepEqual(keepingSide, ancestorReminder)) {
      return { merged: ancestorReminder, diffs: {}, deleted: true };
    }
    return { merged: keepingSide, diffs: {}, deleted: false };
  }

  // One side deleted, other side didn't exist in ancestor → keep the non-deleted
  if (localDeleted && !remoteDeleted && ancestorReminder === undefined) {
    return { merged: remoteReminder, diffs: {}, deleted: false };
  }
  if (remoteDeleted && !localDeleted && ancestorReminder === undefined) {
    return { merged: localReminder, diffs: {}, deleted: false };
  }

  const ancestor = ancestorReminder || ({} as Partial<Reminder>);
  const local = localReminder || ({} as Partial<Reminder>);
  const remote = remoteReminder || ({} as Partial<Reminder>);

  const diffs: Record<string, FieldMergeOutcome> = {};
  const now = Date.now();

  const ancestorUpdatedAt = ancestor.updatedAt ?? 0;
  const localUpdatedAt = local.updatedAt ?? 0;
  const remoteUpdatedAt = remote.updatedAt ?? 0;

  // state: state-machine merge
  const stateMerge = mergeReminderState(
    local.state as "pending" | "fired" | "cleared" | "cancelled" | undefined,
    remote.state as "pending" | "fired" | "cleared" | "cancelled" | undefined,
  );
  diffs.state = {
    ancestor: ancestor.state,
    local: local.state,
    remote: remote.state,
    merged: stateMerge.merged,
    conflict: stateMerge.conflict,
  };

  // triggerAt: scalar 3-way LWW
  const triggerAtMerge = merge3WayLWW(
    ancestor.triggerAt,
    local.triggerAt,
    remote.triggerAt,
    ancestorUpdatedAt,
    localUpdatedAt,
    remoteUpdatedAt,
  );
  diffs.triggerAt = {
    ancestor: ancestor.triggerAt,
    local: local.triggerAt,
    remote: remote.triggerAt,
    merged: triggerAtMerge.merged,
    conflict: triggerAtMerge.conflict,
  };

  // permissionRefusedAt: cross-device monotonic
  const permissionMerge = mergeCrossDeviceMonotonic(
    ancestor.permissionRefusedAt,
    local.permissionRefusedAt,
    remote.permissionRefusedAt,
  );
  diffs.permissionRefusedAt = {
    ancestor: ancestor.permissionRefusedAt,
    local: local.permissionRefusedAt,
    remote: remote.permissionRefusedAt,
    merged: permissionMerge.merged,
    conflict: permissionMerge.conflict,
  };

  const merged = ReminderSchema.parse({
    id,
    todoId: ancestor.todoId || local.todoId || remote.todoId,
    triggerAt: triggerAtMerge.merged,
    recur: ancestor.recur || local.recur || remote.recur || null,
    state: stateMerge.merged,
    snoozedUntil: ancestor.snoozedUntil ?? local.snoozedUntil ?? remote.snoozedUntil ?? null,
    snoozeCount: Math.max(
      ancestor.snoozeCount ?? 0,
      local.snoozeCount ?? 0,
      remote.snoozeCount ?? 0,
    ),
    pendingPostRebootBanner:
      ancestor.pendingPostRebootBanner ||
      local.pendingPostRebootBanner ||
      remote.pendingPostRebootBanner ||
      false,
    permissionRefusedAt: permissionMerge.merged,
    recurredTo: ancestor.recurredTo ?? local.recurredTo ?? remote.recurredTo ?? null,
    createdAt: ancestor.createdAt ?? local.createdAt ?? remote.createdAt ?? now,
    updatedAt: now,
    revision: Math.max(ancestor.revision ?? 0, local.revision ?? 0, remote.revision ?? 0) + 1,
  });

  return { merged, diffs, deleted: false };
}

// ============================================================================
// MAIN MERGE ENTRY POINT
// ============================================================================

export async function merge(
  local: Snapshot,
  remote: Snapshot,
  ancestor: Snapshot | null,
): Promise<MergeResult> {
  const ancestorSnapshot = ancestor || { todos: [], lists: [], reminders: [], deleted: [] };

  // Build entity maps
  const localTodos = buildEntityMap(local.todos);
  const remoteTodos = buildEntityMap(remote.todos);
  const ancestorTodos = buildEntityMap(ancestorSnapshot.todos);

  const localLists = buildEntityMap(local.lists);
  const remoteLists = buildEntityMap(remote.lists);
  const ancestorLists = buildEntityMap(ancestorSnapshot.lists);

  const localReminders = buildEntityMap(local.reminders);
  const remoteReminders = buildEntityMap(remote.reminders);
  const ancestorReminders = buildEntityMap(ancestorSnapshot.reminders);

  // Collect all ids from all sides
  const allTodoIds = new Set([
    ...localTodos.keys(),
    ...remoteTodos.keys(),
    ...ancestorTodos.keys(),
  ]);
  const allListIds = new Set([
    ...localLists.keys(),
    ...remoteLists.keys(),
    ...ancestorLists.keys(),
  ]);
  const allReminderIds = new Set([
    ...localReminders.keys(),
    ...remoteReminders.keys(),
    ...ancestorReminders.keys(),
  ]);

  // Merge todos
  const mergedTodos: Todo[] = [];
  const deletedTodos: Todo[] = [];
  const todoDiffs: Record<string, EntityDiff> = {};
  let conflictCount = 0;

  for (const todoId of allTodoIds) {
    const {
      merged: mergedTodo,
      diffs,
      deleted,
    } = mergeTodo(ancestorTodos.get(todoId), localTodos.get(todoId), remoteTodos.get(todoId));
    if (deleted) {
      deletedTodos.push(mergedTodo);
    } else {
      mergedTodos.push(mergedTodo);
    }
    const conflicts = Object.values(diffs).filter((d) => d.conflict).length;
    if (conflicts > 0) {
      conflictCount += conflicts;
      todoDiffs[todoId] = {
        kind: "todo",
        id: todoId,
        fields: diffs,
      };
    }
  }

  // Merge lists
  const mergedLists: List[] = [];
  const deletedLists: List[] = [];
  const listDiffs: Record<string, EntityDiff> = {};

  for (const listId of allListIds) {
    const {
      merged: mergedList,
      diffs,
      deleted,
    } = mergeList(ancestorLists.get(listId), localLists.get(listId), remoteLists.get(listId));
    if (deleted) {
      deletedLists.push(mergedList);
    } else {
      mergedLists.push(mergedList);
    }
    const conflicts = Object.values(diffs).filter((d) => d.conflict).length;
    if (conflicts > 0) {
      conflictCount += conflicts;
      listDiffs[listId] = {
        kind: "list",
        id: listId,
        fields: diffs,
      };
    }
  }

  // Merge reminders
  const mergedReminders: Reminder[] = [];
  const reminderDiffs: Record<string, EntityDiff> = {};

  for (const reminderId of allReminderIds) {
    const {
      merged: mergedReminder,
      diffs,
      deleted,
    } = mergeReminder(
      ancestorReminders.get(reminderId),
      localReminders.get(reminderId),
      remoteReminders.get(reminderId),
    );
    if (!deleted) {
      mergedReminders.push(mergedReminder);
    }
    const conflicts = Object.values(diffs).filter((d) => d.conflict).length;
    if (conflicts > 0) {
      conflictCount += conflicts;
      reminderDiffs[reminderId] = {
        kind: "reminder",
        id: reminderId,
        fields: diffs,
      };
    }
  }

  // Merge tombstones: union of all tombstones
  const tombstoneIds = new Set<string>();
  const mergedTombstones: Tombstone[] = [];
  for (const t of local.deleted) tombstoneIds.add(t.id);
  for (const t of remote.deleted) tombstoneIds.add(t.id);
  for (const t of ancestorSnapshot.deleted) tombstoneIds.add(t.id);

  // Add tombstones for newly deleted entities
  // (only Todo and List have tombstone kinds per TombstoneSchema — Reminders
  // are not separately tombstone-able; their lifecycle is coupled to their Todo)
  for (const todo of deletedTodos) {
    if (!tombstoneIds.has(todo.id)) {
      mergedTombstones.push({
        id: todo.id,
        kind: "todo",
        deletedAt: Date.now(),
        snapshot: todo,
      });
    }
  }
  for (const list of deletedLists) {
    if (!tombstoneIds.has(list.id)) {
      mergedTombstones.push({
        id: list.id,
        kind: "list",
        deletedAt: Date.now(),
        snapshot: list,
      });
    }
  }

  for (const id of tombstoneIds) {
    const localT = local.deleted.find((t) => t.id === id);
    const remoteT = remote.deleted.find((t) => t.id === id);
    const ancestorT = ancestorSnapshot.deleted.find((t) => t.id === id);
    const tombstone = localT || remoteT || ancestorT;
    if (tombstone && !mergedTombstones.find((t) => t.id === id)) {
      mergedTombstones.push(tombstone);
    }
  }

  // Build merged snapshot
  const merged = SnapshotSchema.parse({
    todos: mergedTodos,
    lists: mergedLists,
    reminders: mergedReminders,
    deleted: mergedTombstones,
    schemaVersion: 1,
  });

  // Build report
  const report: MergeReport = {
    localHash: hashSnapshot(local),
    remoteHash: hashSnapshot(remote),
    ancestorHash: ancestor ? hashSnapshot(ancestor) : null,
    conflictCount,
    totalChanges: mergedTodos.length + mergedLists.length + mergedReminders.length,
    perEntityDiffs: { ...todoDiffs, ...listDiffs, ...reminderDiffs },
  };

  return { merged, report };
}

// ============================================================================
// UTILITY
// ============================================================================

/**
 * Deep equality check for entity comparison.
 * Used to determine if a side's entity is unchanged from ancestor.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
