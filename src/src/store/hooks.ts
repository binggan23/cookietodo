/**
 * React binding over the singleton {@link cookietodoStore} (slice 3).
 *
 * Selector hooks for the data the UI subscribes to (`useTodos`, `useLists`,
 * `useDeleted`, `useLoaded`, `useError`) plus bound action hooks returning
 * the store's methods wired to {@link cookietodoStore} so consumers don't
 * pass the store ref manually.
 *
 * Wave 4 UI imports this surface via `@cookietodo/renderer/store`
 * (see `../../package.json` `exports` map entry `"./store": "./src/store/hooks.ts"`).
 */
import { useStore } from "zustand";
import type { AlarmAdapter } from "../alarm/AlarmAdapter";
import type { List, Reminder, Snapshot, Todo, Tombstone } from "../domain/types";
import type { StoreAdapter } from "../persistence/StoreAdapter";
import type { SyncResult } from "../sync/orchestrator";
import {
  type CookietodoStoreState,
  cookietodoStore,
  createCookietodoStore,
  type ListInput,
  type ListPatch,
  type TodoInput,
  type TodoPatch,
} from "./store";

export type { List, Reminder, Snapshot, Todo, Tombstone } from "../domain/types";
// Re-export the public store surface + input types so the UI imports one module.
export {
  type CookietodoStoreState,
  cookietodoStore,
  createCookietodoStore,
  type ListInput,
  ListInputSchema,
  type ListPatch,
  type TodoInput,
  TodoInputSchema,
  type TodoPatch,
} from "./store";

/**
 * Test seam: construct a fresh bound store for an alternative adapter
 * (e.g. `MemoryStoreAdapter` in Vitest). The default singleton resolves from
 * `window.cookietodoStoreAdapter` (Wave 3 preload) or falls back to
 * `MemoryStoreAdapter`; this hook lets a test override that decision.
 *
 * Slice 5: takes a 2nd `alarmAdapter` so the per-test store can be wired to a
 * fresh `createElectronAlarmStub()`. When a test passes `adapter` without
 * `alarmAdapter` — that's a slice-4 callersite that forgot the slice-5
 * addition — we throw at hook-time so the misuse fails loud. Slice-4 callers
 * that pass nothing continue to use the singleton (the contract is unchanged
 * for the no-arg slot).
 */
export function useCookietodoStore(
  adapter?: StoreAdapter,
  alarmAdapter?: AlarmAdapter,
): CookietodoStoreState {
  const store =
    adapter === undefined
      ? cookietodoStore
      : alarmAdapter === undefined
        ? null // unreachable — thrown below for the early-fail ergonomic misuse
        : createCookietodoStore(adapter, alarmAdapter);
  if (store === null) {
    throw new Error(
      "useCookietodoStore: when overriding the StoreAdapter you must also pass an AlarmAdapter (slice 5 — ADR 0006 Reminder state-machine expects a deterministic subscription).",
    );
  }
  return useStore(store);
}
/** Data selector hooks — bound to the singleton {@link cookietodoStore}. */

export function useTodos(): Todo[] {
  return useStore(cookietodoStore, (s) => s.snapshot.todos);
}

export function useReminders(): Reminder[] {
  return useStore(cookietodoStore, (s) => s.snapshot.reminders);
}

export function useLists(): List[] {
  return useStore(cookietodoStore, (s) => s.snapshot.lists);
}

export function useDeleted(): Tombstone[] {
  return useStore(cookietodoStore, (s) => s.snapshot.deleted);
}

export function useLoaded(): boolean {
  return useStore(cookietodoStore, (s) => s.loaded);
}

export function useError(): string | null {
  return useStore(cookietodoStore, (s) => s.error);
}

export function useSnapshot(): Snapshot {
  return useStore(cookietodoStore, (s) => s.snapshot);
}

/**
 * Action hooks — each returns the bound action so a UI consumer destructures
 * `const { createTodo } = useCreateTodo()` (or `useCreateTodo()` and call the
 * returned method, depending on style). All bound to the singleton
 * {@link cookietodoStore}: the mutation's plain lifecycle is the same as the
 * store's plain method; persistence happens fire-and-forget behind the scenes.
 */

export function useLoad(): () => Promise<void> {
  return useStore(cookietodoStore, (s) => s.load);
}

export function useReplaceSnapshot(): (snapshot: Snapshot) => void {
  return useStore(cookietodoStore, (s) => s.replaceSnapshot);
}

export function useClearRebootBanner(): (id: Reminder["id"]) => void {
  return useStore(cookietodoStore, (s) => s.clearRebootBanner);
}

export function useSync(): (remote: Snapshot) => Promise<SyncResult> {
  return useStore(cookietodoStore, (s) => s.sync);
}

export function useRevertLastMerge(): () => Promise<boolean> {
  return useStore(cookietodoStore, (s) => s.revertLastMerge);
}

export function useSyncStatus(): "idle" | "syncing" | "offline" | "suspended" {
  return useStore(cookietodoStore, (s) => s.syncStatus);
}

export function useLastSyncResult(): SyncResult | null {
  return useStore(cookietodoStore, (s) => s.lastSyncResult);
}

export function useSyncIntervalMinutes(): number {
  return useStore(cookietodoStore, (s) => s.syncIntervalMinutes);
}

export function useCreateTodo(): (input: TodoInput) => Todo {
  return useStore(cookietodoStore, (s) => s.createTodo);
}

export function useUpdateTodo(): (id: Todo["id"], patch: TodoPatch) => void {
  return useStore(cookietodoStore, (s) => s.updateTodo);
}

export function useDeleteTodo(): (id: Todo["id"]) => void {
  return useStore(cookietodoStore, (s) => s.deleteTodo);
}

export function useToggleCompleted(): (id: Todo["id"]) => void {
  return useStore(cookietodoStore, (s) => s.toggleCompleted);
}

export function useAddToList(): (todoId: Todo["id"], listId: List["id"]) => void {
  return useStore(cookietodoStore, (s) => s.addToList);
}

export function useRemoveFromList(): (todoId: Todo["id"], listId: List["id"]) => void {
  return useStore(cookietodoStore, (s) => s.removeFromList);
}

export function useCreateList(): (input: ListInput) => List {
  return useStore(cookietodoStore, (s) => s.createList);
}

export function useUpdateList(): (id: List["id"], patch: ListPatch) => void {
  return useStore(cookietodoStore, (s) => s.updateList);
}

export function useDeleteList(): (id: List["id"]) => void {
  return useStore(cookietodoStore, (s) => s.deleteList);
}
