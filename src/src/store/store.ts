/**
 * cookietodo Zustand Store — slice 3 (ADR 0006).
 *
 * Vanilla store from `zustand/vanilla` (no React dependency) so the store is
 * testable headless and reusable across the Electron `main`/`renderer` split
 * (slice 4+ Sync lives where the bytes do). `hooks.ts` binds React on top.
 *
 * Construction:
 *   `createCookietodoStore(adapter: StoreAdapter)` — accepts the adapter as a
 *   constructor param so callers wire in the right one (renderer IPC proxy,
 *   `MemoryStoreAdapter`, the future Capacitor Filesystem adapter). Mirrors
 *   slice 2's `resolveDeviceAdapter` decision pattern — accept the
 *   dependency, do not import the world. The singleton `cookietodoStore`
 *   below resolves from `window.cookietodoStoreAdapter` (preload-injected,
 *   Wave 3) with the in-memory stub as fallback (mirrors
 *   `electronRendererStub`).
 *
 * Persistence shape:
 *   - Every mutation is SYNC in shape — it updates state and snapshot first,
 *     then fires `void adapter.saveSnapshot(getState().snapshot)` async
 *     (fire-and-forget; errors logged via `console.error`, never thrown — the
 *     next mutation supersedes this save and a stale write is harmless because
 *     load re-validates through `SnapshotSchema`).
 *   - `load()` is the only async action exposed; the renderer calls it on
 *     mount. It re-parses through `SnapshotSchema` (parse-don't-validate) so
 *     the trusted boundary is the adapter, not the in-memory tree.
 *
 * Mutation discipline (ADR 0006 + ADR 0004):
 *   - Immutable spreads (no immer). Whole-tree replace on every mutation.
 *   - Every assembled entity is re-parsed through `*Schema.parse` BEFORE the
 *     state mutation lands (parse-don't-validate). A ZodError sets the store's
 *     `error` and aborts the mutation — no half-built entities reach state.
 *     This catches the `reminderId != null ⟹ dueAt != null` invariant on
 *     `updateTodo`, the `listIds` ULID-format invariant, etc.
 *   - Tombstones (ADR 0004) move the just-deleted entity into
 *     `snapshot.deleted` with `{ id, kind, deletedAt, snapshot }`. Slice 3
 *     retains tombstones indefinitely; GC/TTL lands in slice 7.
 *   - `deleteList` ALSO cascades: any Todo whose `listIds` contained the list
 *     has the listId removed (bump those Todos' `revision` + `updatedAt`) so
 *     dangling references never survive.
 */

import { ulid } from "ulid";
import * as z from "zod";
import { createStore, type StoreApi } from "zustand/vanilla";
import {
  epochMs,
  HEX_COLOR_RE,
  IdSchema,
  type List,
  ListSchema,
  type Snapshot,
  SnapshotSchema,
  type Todo,
  TodoSchema,
  type Tombstone,
} from "../domain/types";
import { MemoryStoreAdapter } from "../persistence/MemoryStoreAdapter";
import type { StoreAdapter } from "../persistence/StoreAdapter";

/**
 * Input shape for {@link CookietodoStoreApi.createTodo}. Covers the
 * user-supplied fields only — the Store mints `id`, `createdAt`, `updatedAt`,
 * `revision`.
 *
 * NOTE: this is NOT `TodoSchema.pick(...)` — `TodoSchema.superRefine` is
 * linked and Zod 4 throws `.pick() cannot be used on object schemas
 * containing refinements` at runtime (TS does not catch this). So the
 * input schema is built bottom-up from the same leaf schemas, and the
 * `reminderId != null ⟹ dueAt != null` invariant is enforced by the parent
 * `TodoSchema.parse` on the assembled entity (every createTodo path
 * re-parses through `TodoSchema.parse`, so the superRefine runs there).
 *
 * Re-derived in `hooks.ts` so the UI imports the input type, not the full
 * `Todo`.
 */
export const TodoInputSchema = z.strictObject({
  title: z.string().max(200),
  notes: z.string(),
  listIds: z.array(IdSchema),
  completed: z.boolean(),
  completedAt: epochMs.nullable(),
  dueAt: epochMs.nullable(),
  reminderId: IdSchema.nullable(),
});
export type TodoInput = z.infer<typeof TodoInputSchema>;

/**
 * Input shape for {@link CookietodoStoreApi.createList}. Store mints `id`,
 * `createdAt`, `updatedAt`, `revision`.
 */
export const ListInputSchema = z.strictObject({
  name: z.string().max(80),
  color: z.string().regex(HEX_COLOR_RE).nullable(),
});
export type ListInput = z.infer<typeof ListInputSchema>;

/** Patch allowed on `updateTodo`. All fields optional; partial of `Todo`. */
export type TodoPatch = Partial<Omit<Todo, "id" | "createdAt" | "updatedAt" | "revision">>;
/** Patch allowed on `updateList`. */
export type ListPatch = Partial<Omit<List, "id" | "createdAt" | "updatedAt" | "revision">>;

/**
 * Slice-3 Store action surface. `load()` is async (the renderer calls it on
 * mount); all mutations are SYNC in shape and fire `adapter.saveSnapshot`
 * async after the state mutation.
 *
 * Slice 4 adds `replaceSnapshot(snapshot)`: the Import flow parses + Zod-validates
 * a user-picked Snapshot file, then atomically swaps the in-memory store with it
 * and persists via `saveSnapshot` (ADR 0001 + ADR 0003). Single authoritative
 * writer per Import — matches ADR 0003 atomic-write budget; Import is NOT a
 * field-level merge (that's slice 7 Sync — ADR 0004 3-way merge).
 */
export interface CookietodoStoreApi {
  load(): Promise<void>;
  replaceSnapshot(snapshot: Snapshot): void;
  createTodo(input: TodoInput): Todo;
  updateTodo(id: Todo["id"], patch: TodoPatch): void;
  deleteTodo(id: Todo["id"]): void;
  toggleCompleted(id: Todo["id"]): void;
  addToList(todoId: Todo["id"], listId: List["id"]): void;
  removeFromList(todoId: Todo["id"], listId: List["id"]): void;
  createList(input: ListInput): List;
  updateList(id: List["id"], patch: ListPatch): void;
  deleteList(id: List["id"]): void;
}

/** Full state returned by `getState()` — the data the UI subscribes to. */
export interface CookietodoStoreState extends CookietodoStoreApi {
  snapshot: Snapshot;
  loaded: boolean;
  error: string | null;
}

/**
 * Window-global injected by the Electron preload (Wave 3) — supplies the
 * shell-appropriate `StoreAdapter` (renderer IPC proxy). `MemoryStoreAdapter`
 * is the fallback when no preload is present (Vitest, headless Vite preview).
 * Mirrors the slice-2 `window.cookietodoDeviceAdapter` convention.
 */
declare global {
  interface Window {
    cookietodoStoreAdapter?: () => StoreAdapter;
  }
}

/**
 * Empty Snapshot used as the pre-`load()` seed (the Store is constructed with
 * it so `loaded:false` is observable before the first adapter read). Parsing
 * `{}` is the same path `MemoryStoreAdapter` uses — every collection defaults
 * to `[]` and `schemaVersion` defaults to `1` per {@link SnapshotSchema}.
 */
const EMPTY_SNAPSHOT: Snapshot = SnapshotSchema.parse({});

/**
 * Construct a cookietodo vanilla store bound to the given {@link StoreAdapter}.
 * Pure constructor — no module side effects. The adapter resolution decision
 * (renderer IPC vs in-memory stub) is the caller's, not the store's.
 */
export function createCookietodoStore(adapter: StoreAdapter): StoreApi<CookietodoStoreState> {
  return createStore<CookietodoStoreState>((set, get) => {
    /**
     * Best-effort snapshot persistence. Fire-and-forget: never throws into
     * the synchronous mutation that called it (the next mutation supersedes
     * this save; `load` re-validates so a stale write is harmless). Errors
     * are logged so a persistence failure is visible in dev without
     * poisoning the synchronous call site.
     */
    const persist = (): void => {
      void adapter.saveSnapshot(get().snapshot).catch((err: unknown) => {
        console.error("cookietodo store: adapter.saveSnapshot failed", err);
      });
    };

    return {
      snapshot: EMPTY_SNAPSHOT,
      loaded: false,
      error: null,

      async load(): Promise<void> {
        try {
          const snapshot = SnapshotSchema.parse(await adapter.loadSnapshot());
          set({ snapshot, loaded: true, error: null });
        } catch (err) {
          if (err instanceof z.ZodError) {
            set({ loaded: true, error: err.message });
            return;
          }
          set({ loaded: true, error: String(err) });
        }
      },

      replaceSnapshot(snapshot: Snapshot): void {
        try {
          const validated = SnapshotSchema.parse(snapshot);
          set({ snapshot: validated, loaded: true, error: null });
          persist();
        } catch (err) {
          set({ error: err instanceof z.ZodError ? err.message : String(err) });
        }
      },

      createTodo(input: TodoInput): Todo {
        try {
          const now = Date.now();
          const assembled: Todo = {
            id: ulid() as Todo["id"],
            title: input.title,
            notes: input.notes,
            listIds: [...input.listIds],
            completed: input.completed,
            completedAt: input.completedAt,
            dueAt: input.dueAt,
            reminderId: input.reminderId,
            createdAt: now,
            updatedAt: now,
            revision: 0,
          };
          const todo = TodoSchema.parse(assembled);
          set((state) => ({
            snapshot: { ...state.snapshot, todos: [...state.snapshot.todos, todo] },
            error: null,
          }));
          persist();
          return todo;
        } catch (err) {
          set({ error: err instanceof z.ZodError ? err.message : String(err) });
          // Re-throw synchronous so a caller that depends on the returned
          // Todo does not silently receive `undefined`; the state mutation
          // above never ran.
          throw err;
        }
      },

      updateTodo(id: Todo["id"], patch: TodoPatch): void {
        const state = get();
        const idx = state.snapshot.todos.findIndex((t) => t.id === id);
        if (idx === -1) {
          set({ error: `updateTodo: no Todo with id "${id}"` });
          return;
        }
        const existing = state.snapshot.todos[idx];
        if (existing === undefined) {
          set({ error: `updateTodo: no Todo with id "${id}"` });
          return;
        }
        try {
          const updated = TodoSchema.parse({
            ...existing,
            ...patch,
            listIds: patch.listIds === undefined ? existing.listIds : [...patch.listIds],
            id,
            createdAt: existing.createdAt,
            updatedAt: Date.now(),
            revision: existing.revision + 1,
          });
          const todos = state.snapshot.todos.map((t, i) => (i === idx ? updated : t));
          set({ snapshot: { ...state.snapshot, todos }, error: null });
          persist();
        } catch (err) {
          set({ error: err instanceof z.ZodError ? err.message : String(err) });
        }
      },

      deleteTodo(id: Todo["id"]): void {
        const state = get();
        const idx = state.snapshot.todos.findIndex((t) => t.id === id);
        if (idx === -1) {
          set({ error: `deleteTodo: no Todo with id "${id}"` });
          return;
        }
        const deleted = state.snapshot.todos[idx];
        if (deleted === undefined) {
          set({ error: `deleteTodo: no Todo with id "${id}"` });
          return;
        }
        const now = Date.now();
        const tombstone: Tombstone = {
          id: deleted.id,
          kind: "todo",
          deletedAt: now,
          snapshot: deleted,
        };
        const todos = state.snapshot.todos.filter((t) => t.id !== id);
        set({
          snapshot: { ...state.snapshot, todos, deleted: [...state.snapshot.deleted, tombstone] },
          error: null,
        });
        persist();
      },

      toggleCompleted(id: Todo["id"]): void {
        const state = get();
        const idx = state.snapshot.todos.findIndex((t) => t.id === id);
        if (idx === -1) {
          set({ error: `toggleCompleted: no Todo with id "${id}"` });
          return;
        }
        const existing = state.snapshot.todos[idx];
        if (existing === undefined) {
          set({ error: `toggleCompleted: no Todo with id "${id}"` });
          return;
        }
        try {
          const now = Date.now();
          const completed = !existing.completed;
          const updated = TodoSchema.parse({
            ...existing,
            completed,
            completedAt: completed ? now : null,
            updatedAt: now,
            revision: existing.revision + 1,
          });
          const todos = state.snapshot.todos.map((t, i) => (i === idx ? updated : t));
          set({ snapshot: { ...state.snapshot, todos }, error: null });
          persist();
        } catch (err) {
          set({ error: err instanceof z.ZodError ? err.message : String(err) });
        }
      },

      addToList(todoId: Todo["id"], listId: List["id"]): void {
        const state = get();
        const idx = state.snapshot.todos.findIndex((t) => t.id === todoId);
        if (idx === -1) {
          set({ error: `addToList: no Todo with id "${todoId}"` });
          return;
        }
        const existing = state.snapshot.todos[idx];
        if (existing === undefined) {
          set({ error: `addToList: no Todo with id "${todoId}"` });
          return;
        }
        if (existing.listIds.includes(listId)) {
          return; // set-union semantics (ADR 0006) — no duplicates, no-op.
        }
        try {
          const now = Date.now();
          const updated = TodoSchema.parse({
            ...existing,
            listIds: [...existing.listIds, listId],
            updatedAt: now,
            revision: existing.revision + 1,
          });
          const todos = state.snapshot.todos.map((t, i) => (i === idx ? updated : t));
          set({ snapshot: { ...state.snapshot, todos }, error: null });
          persist();
        } catch (err) {
          set({ error: err instanceof z.ZodError ? err.message : String(err) });
        }
      },

      removeFromList(todoId: Todo["id"], listId: List["id"]): void {
        const state = get();
        const idx = state.snapshot.todos.findIndex((t) => t.id === todoId);
        if (idx === -1) {
          set({ error: `removeFromList: no Todo with id "${todoId}"` });
          return;
        }
        const existing = state.snapshot.todos[idx];
        if (existing === undefined) {
          set({ error: `removeFromList: no Todo with id "${todoId}"` });
          return;
        }
        if (!existing.listIds.includes(listId)) {
          return; // no-op when not present.
        }
        try {
          const now = Date.now();
          const updated = TodoSchema.parse({
            ...existing,
            listIds: existing.listIds.filter((id) => id !== listId),
            updatedAt: now,
            revision: existing.revision + 1,
          });
          const todos = state.snapshot.todos.map((t, i) => (i === idx ? updated : t));
          set({ snapshot: { ...state.snapshot, todos }, error: null });
          persist();
        } catch (err) {
          set({ error: err instanceof z.ZodError ? err.message : String(err) });
        }
      },

      createList(input: ListInput): List {
        try {
          const now = Date.now();
          const assembled: List = {
            id: ulid() as List["id"],
            name: input.name,
            color: input.color,
            createdAt: now,
            updatedAt: now,
            revision: 0,
          };
          const list = ListSchema.parse(assembled);
          set((state) => ({
            snapshot: { ...state.snapshot, lists: [...state.snapshot.lists, list] },
            error: null,
          }));
          persist();
          return list;
        } catch (err) {
          set({ error: err instanceof z.ZodError ? err.message : String(err) });
          throw err;
        }
      },

      updateList(id: List["id"], patch: ListPatch): void {
        const state = get();
        const idx = state.snapshot.lists.findIndex((l) => l.id === id);
        if (idx === -1) {
          set({ error: `updateList: no List with id "${id}"` });
          return;
        }
        const existing = state.snapshot.lists[idx];
        if (existing === undefined) {
          set({ error: `updateList: no List with id "${id}"` });
          return;
        }
        try {
          const updated = ListSchema.parse({
            ...existing,
            ...patch,
            id,
            createdAt: existing.createdAt,
            updatedAt: Date.now(),
            revision: existing.revision + 1,
          });
          const lists = state.snapshot.lists.map((l, i) => (i === idx ? updated : l));
          set({ snapshot: { ...state.snapshot, lists }, error: null });
          persist();
        } catch (err) {
          set({ error: err instanceof z.ZodError ? err.message : String(err) });
        }
      },

      deleteList(id: List["id"]): void {
        const state = get();
        const idx = state.snapshot.lists.findIndex((l) => l.id === id);
        if (idx === -1) {
          set({ error: `deleteList: no List with id "${id}"` });
          return;
        }
        const deleted = state.snapshot.lists[idx];
        if (deleted === undefined) {
          set({ error: `deleteList: no List with id "${id}"` });
          return;
        }
        const now = Date.now();
        const tombstone: Tombstone = {
          id: deleted.id,
          kind: "list",
          deletedAt: now,
          snapshot: deleted,
        };
        // Cascading cleanup: any Todo referencing this List loses the listId
        // (bumps `revision` + `updatedAt` so the change is observable). Dangling
        // references never survive a delete (ADR 0006 listIds semantics).
        let touched = false;
        const todos: Todo[] = [];
        for (const t of state.snapshot.todos) {
          if (t.listIds.includes(id)) {
            // Re-parse to catch invariants the cascade might violate (none
            // currently, but the contract is uniform across mutations).
            const updated = TodoSchema.parse({
              ...t,
              listIds: t.listIds.filter((lid) => lid !== id),
              updatedAt: now,
              revision: t.revision + 1,
            });
            todos.push(updated);
            touched = true;
          } else {
            todos.push(t);
          }
        }
        const lists = state.snapshot.lists.filter((l) => l.id !== id);
        set({
          snapshot: {
            ...state.snapshot,
            todos: touched ? todos : state.snapshot.todos,
            lists,
            deleted: [...state.snapshot.deleted, tombstone],
          },
          error: null,
        });
        persist();
      },
    };
  });
}

/**
 * Singleton store bound to the shell-appropriate adapter. Mirrors the slice-2
 * `resolveDeviceAdapter` decision: read the preload-injected adapter off the
 * window-global, fall back to {@link MemoryStoreAdapter} when no preload is
 * present (Vitest, headless Vite preview, no Electron shell).
 *
 * The `typeof window === "undefined"` guard mirrors the slice-2
 * `electronRendererStub.localStorageOrThrow` defensive pattern — in a Node
 * Vitest environment there is no global `window`, and we must not throw at
 * module-init time or the test file fails to import. The single Electron
 * shell + Vite preview + browser-tabs all define `window`.
 */
const fallbackStoreAdapter = new MemoryStoreAdapter();

function resolveStoreAdapter(): StoreAdapter {
  if (typeof window === "undefined") {
    return fallbackStoreAdapter;
  }
  return window.cookietodoStoreAdapter?.() ?? fallbackStoreAdapter;
}

const lazyStoreAdapter: StoreAdapter = {
  loadSnapshot: () => resolveStoreAdapter().loadSnapshot(),
  saveSnapshot: (snapshot) => resolveStoreAdapter().saveSnapshot(snapshot),
  importSnapshot: (file) => resolveStoreAdapter().importSnapshot(file),
  exportSnapshot: () => resolveStoreAdapter().exportSnapshot(),
};

export const cookietodoStore: StoreApi<CookietodoStoreState> =
  createCookietodoStore(lazyStoreAdapter);
