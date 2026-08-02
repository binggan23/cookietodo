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
import type { List, Todo, Tombstone } from "../domain/types";
import type { StoreAdapter } from "../persistence/StoreAdapter";
import {
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

export type { List, Todo, Tombstone } from "../domain/types";
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
};

/**
 * Test seam: construct a fresh bound store for an alternative adapter
 * (e.g. `MemoryStoreAdapter` in Vitest). The default singleton resolves from
 * `window.cookietodoStoreAdapter` (Wave 3 preload) or falls back to
 * `MemoryStoreAdapter`; this hook lets a test override that decision.
 */
export function useCookietodoStore(adapter?: StoreAdapter): CookietodoStoreState {
  const store = adapter === undefined ? cookietodoStore : createCookietodoStore(adapter);
  return useStore(store);
}

/** Data selector hooks — bound to the singleton {@link cookietodoStore}. */

export function useTodos(): Todo[] {
  return useStore(cookietodoStore, (s) => s.snapshot.todos);
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
