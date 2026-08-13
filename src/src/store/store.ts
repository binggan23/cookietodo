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
import type { AlarmActionPayload, AlarmAdapter, AlarmFiredPayload } from "../alarm/AlarmAdapter";
import { electronAlarmStub } from "../alarm/electronRendererStub";
import { computeNextTriggerAt } from "../alarm/scheduler";
import { MAX_SNOOZES, SNOOZE_INTERVAL_MS } from "../alarm/snoozeConfig";
import {
  epochMs,
  HEX_COLOR_RE,
  IdSchema,
  type List,
  ListSchema,
  type Recurrence,
  RecurrenceSchema,
  type Reminder,
  ReminderSchema,
  type Snapshot,
  SnapshotSchema,
  type Todo,
  TodoSchema,
  type Tombstone,
} from "../domain/types";
import { MemoryStoreAdapter } from "../persistence/MemoryStoreAdapter";
import type { StoreAdapter } from "../persistence/StoreAdapter";
import type { SyncResult } from "../sync/orchestrator";
import { revertLastMerge as orchestratorRevertLastMerge, runSync } from "../sync/orchestrator";

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
 * Slice 5 adds `reminderTriggerAt` — the fire time of the Reminder entity.
 * Coupled invariant enforced here via `superRefine` (mirrors TodoSchema's
 * reminderId↔dueAt link): `reminderId !== null ⟺ reminderTriggerAt !== null`
 * AND `reminderId !== null ⟹ dueAt !== null`. The store passes this value
 * through to the assembled Reminder as `triggerAt` (per AC #4: defaults to
 * the Todo's `dueAt` in the editor UI; the user can override it separately
 * for "remind me 5 minutes before due").
 *
 * Re-derived in `hooks.ts` so the UI imports the input type, not the full
 * `Todo`.
 */
export const TodoInputSchema = z
  .strictObject({
    title: z.string().max(200),
    notes: z.string(),
    listIds: z.array(IdSchema),
    completed: z.boolean(),
    completedAt: epochMs.nullable(),
    dueAt: epochMs.nullable(),
    reminderId: IdSchema.nullable(),
    /** Slice 5 — fire time for the Reminder entity. `null` when `reminderId` is `null`. */
    reminderTriggerAt: epochMs.nullable(),
    /** Slice 9 — recurrence configuration for the Reminder. `null` when `reminderId` is `null`. */
    reminderRecur: RecurrenceSchema.nullable(),
  })
  .superRefine((input, ctx) => {
    if (input.reminderId !== null && input.dueAt === null) {
      // Mirror the slice-3 TodoSchema superRefine at the input boundary so
      // `TodoInputSchema.safeParse` itself rejects the half-built reminder —
      // the slice-3 contract was enforced only on `TodoSchema.parse`; the
      // slice-5 input surface moves the guard earlier so the form-layer
      // validation never reaches `createTodo`.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Todo.reminderId != null requires Todo.dueAt != null — a Reminder cannot exist without a dueAt (ADR 0006).",
        path: ["dueAt"],
      });
    }
    if (input.reminderId !== null && input.reminderTriggerAt === null) {
      // Reminder armed but no triggerAt — UI bug (the form's `triggerAt`
      // input must default to the Todo's `dueAt`). Reject at the Zod
      // boundary so a half-built Reminder never reaches the Store.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Todo.reminderId != null requires Todo.reminderTriggerAt != null — a Reminder entity needs a fire time (ADR 0006 + slice 5).",
        path: ["reminderTriggerAt"],
      });
    }
    if (input.reminderId === null && input.reminderTriggerAt !== null) {
      // Orphan triggerAt — a UI bug the other direction. Reject so the
      // Reminder entity is not created half-armed; the superRefine pairs
      // 1:1 with the reminderId hole.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Todo.reminderTriggerAt != null requires Todo.reminderId != null — orphan triggerAt (slice 5).",
        path: ["reminderId"],
      });
    }
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
export type TodoPatch = Partial<Omit<Todo, "id" | "createdAt" | "updatedAt" | "revision">> & {
  /**
   * Slice 5 — fire time for the Reminder entity when `reminderId` changes.
   * Lives here (not on the Todo entity) because `triggerAt` is a Reminder
   * field, but `updateTodo` is the canonical mutation that arming/retiring
   * a Reminder passes through. Coupled with `reminderId`:
   *   - `reminderId === null` ⟺ `reminderTriggerAt === null`
   *   - `reminderId !== null` ⟹ `reminderTriggerAt !== null`
   *   - Both undefined ⟹ leave the Reminder entity as-is (no field mutation).
   */
  reminderTriggerAt?: number | null;
  /** Slice 9 — recurrence configuration for the Reminder. */
  reminderRecur?: Recurrence | null;
};
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
  /** Slice 6 — dismiss the fired post-reboot banner for a Reminder (issue AC #8). */
  clearRebootBanner(reminderId: Reminder["id"]): void;
  /**
   * Slice 7 — run a manual Sync pass. Merges the current local snapshot with
   * the given remote snapshot (ADR 0004 3-way field-level merge), persists the
   * result, and appends a history entry. Returns the SyncResult for the UI.
   */
  sync(remote: Snapshot): Promise<SyncResult>;
  /**
   * Slice 7 — revert the last merge. Restores the active snapshot to the state
   * before the most recent sync. Returns true on success, false if no history.
   */
  revertLastMerge(): Promise<boolean>;
}

/** Full state returned by `getState()` — the data the UI subscribes to. */
export interface CookietodoStoreState extends CookietodoStoreApi {
  snapshot: Snapshot;
  loaded: boolean;
  error: string | null;
  /** Slice 8 — sync scheduler status (idle/syncing/offline/suspended). */
  syncStatus: "idle" | "syncing" | "offline" | "suspended";
  /** Slice 8 — outcome of the last sync pass (null = never synced via WebDAV). */
  lastSyncResult: SyncResult | null;
  /** Slice 8 — current sync interval in minutes. */
  syncIntervalMinutes: number;
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
 * Construct a cookietodo vanilla store bound to the given {@link StoreAdapter}
 * and {@link AlarmAdapter}. Pure constructor — no module side effects. The
 * adapter resolution decisions (renderer IPC vs in-memory stub) are the
 * caller's, not the store's.
 *
 * Slice 5: the store takes a 2nd `alarmAdapter` param so a Vitest per-test
 * store can be wired to a fresh stub. The store subscribes to
 * `alarmAdapter.onAlarmFired` ONCE INSIDE this factory (per-instance
 * subscription) so the singleton `cookietodoStore` exported below and each
 * per-test `createCookietodoStore(...)` callsite each get exactly one
 * subscriber bound to the adapter they were constructed with — never zero
 * (singleton + stub race) and never double (外公 closure leak). When the
 * shell pushes a fire event for a Reminder we own, we mutate its
 * `state pending → 'fired'` per ADR 0006 (slice-5 floor — `fired` stays
 * `fired`; the password-dismiss + complete=true mutation lands in slice 6).
 */
export function createCookietodoStore(
  adapter: StoreAdapter,
  alarmAdapter: AlarmAdapter,
): StoreApi<CookietodoStoreState> {
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

    /**
     * Fire-and-forget alarm scheduling — the synchronous mutation has
     * already written the Reminder entity to the snapshot, so a
     * `scheduleAlarm` failure means the Store + on-disk have a `pending`
     * Reminder whose timer never armed; ADR 0002 Level B requires "must
     * fire" so slice 6 must surface this to the UI. Slice 5 floor logs
     * the error and proceeds — the Store's contract is "we wrote the
     * Reminder and asked the shell to arm it"; the shell's arm-failure UX
     * is downstream of this slice's AC scope.
     */
    const scheduleIfArmed = (reminder: Reminder | null, todo: Todo): void => {
      if (reminder === null) return;
      if (reminder.state !== "pending") return;
      void alarmAdapter.scheduleAlarm(reminder, todo).catch((err: unknown) => {
        console.error("cookietodo store: alarmAdapter.scheduleAlarm failed", err);
      });
    };
    const cancelIfArmed = (reminderId: Reminder["id"] | null): void => {
      if (reminderId === null) return;
      void alarmAdapter.cancelAlarm(reminderId).catch((err: unknown) => {
        console.error("cookietodo store: alarmAdapter.cancelAlarm failed", err);
      });
    };

    /**
     * Update a stored Reminder (used by the slice-5 fire callback — slice
     * 6 will extend this to also mutate `Todo.completed` / `completedAt`).
     */
    const updateReminder = (id: Reminder["id"], patch: Partial<Reminder>): void => {
      const state = get();
      const idx = state.snapshot.reminders.findIndex((r) => r.id === id);
      if (idx === -1) {
        set({ error: `updateReminder: no Reminder with id "${id}"` });
        return;
      }
      const existing = state.snapshot.reminders[idx];
      if (existing === undefined) {
        set({ error: `updateReminder: no Reminder with id "${id}"` });
        return;
      }
      try {
        const updated = ReminderSchema.parse({
          ...existing,
          ...patch,
          id: existing.id,
          todoId: existing.todoId,
          createdAt: existing.createdAt,
          updatedAt: Date.now(),
          revision: existing.revision + 1,
        });
        const reminders = state.snapshot.reminders.map((r, i) => (i === idx ? updated : r));
        set({ snapshot: { ...state.snapshot, reminders }, error: null });
        persist();
      } catch (err) {
        set({ error: err instanceof z.ZodError ? err.message : String(err) });
      }
    };

    /**
     * Slice 6 — completion clears the reminder (ADR 0007 C-extension): manual
     * "mark complete" is the offline equivalent of password-dismiss, so the
     * owning Reminder advances `pending`/`fired` → `cleared` in the same
     * mutation. Terminal states (`cleared`/`cancelled`) pass through unchanged
     * (monotonic — never regress; issue AC #9 un-complete-then-resolve keeps
     * the cleared reminder terminal).
     */
    const clearReminderOnCompletion = (
      reminders: Reminder[],
      todoId: Todo["id"],
      now: number,
    ): Reminder[] =>
      reminders.map((r) =>
        r.todoId === todoId && (r.state === "pending" || r.state === "fired")
          ? ReminderSchema.parse({
              ...r,
              state: "cleared",
              pendingPostRebootBanner: false,
              updatedAt: now,
              revision: r.revision + 1,
            })
          : r,
      );

    // Per-instance subscription — DEFINES the contract a Vitest store
    // exercises when it asserts `subscribers.length === 1`. When the shell
    // pushes a fire event, locate the Reminder we own and flip its state.
    // Mirrors the slice-2/store singleton adapter resolution: each store
    // construct subscribes once; the singleton passes the same adapter it
    // was constructed with.
    void alarmAdapter.onAlarmFired((payload: AlarmFiredPayload) => {
      updateReminder(payload.reminderId, { state: "fired" });
    });

    // Slice 9 — fire-and-forget recurrence scheduling after a completion event
    // (dismiss or toggle). Computes the next trigger and adds a new Reminder
    // entity + alarm in a second set+persist pass, since the initial synchronous
    // mutation has already cleared the parent and completed the Todo. This is
    // called after persist() in both dismiss and toggleCompleted paths.
    const scheduleRecurrenceAsync = async (
      oldReminder: Reminder | undefined,
      todo: Todo,
      completedAt: number,
    ): Promise<void> => {
      if (oldReminder === undefined) return;
      if (oldReminder.recur === null) return;
      try {
        const now = Date.now();
        const nextTriggerAt = await computeNextTriggerAt(
          oldReminder.recur,
          completedAt,
          oldReminder.triggerAt,
        );
        if (nextTriggerAt === null) return;
        const newReminder = ReminderSchema.parse({
          id: ulid() as Reminder["id"],
          todoId: todo.id,
          triggerAt: nextTriggerAt,
          recur: { ...oldReminder.recur },
          state: "pending",
          snoozedUntil: null,
          snoozeCount: 0,
          pendingPostRebootBanner: false,
          permissionRefusedAt: null,
          recurredTo: null,
          createdAt: now,
          updatedAt: now,
          revision: 0,
        });
        set((st) => ({
          snapshot: {
            ...st.snapshot,
            reminders: [
              ...st.snapshot.reminders.map((r) =>
                r.id === oldReminder.id ? { ...r, recurredTo: newReminder.id } : r,
              ),
              newReminder,
            ],
          },
          error: null,
        }));
        const currentState = get();
        const currentTodo = currentState.snapshot.todos.find((t) => t.id === todo.id);
        if (currentTodo !== undefined) {
          scheduleIfArmed(newReminder, currentTodo);
        }
        persist();
      } catch (err) {
        console.error("cookietodo store: scheduleRecurrenceAsync failed", err);
      }
    };

    // Slice 6 — password-dismiss (ADR 0007 Decision A). The shell closed the
    // Alarm Event after a correct 6-digit password; the store advances the
    // Reminder `fired` → `cleared` AND the owning Todo → completed in ONE
    // set + persist (the AC "one atomic transaction" — the persisted snapshot
    // image carries both changes together).
    void alarmAdapter.onAlarmDismissed((payload: AlarmActionPayload) => {
      const state = get();
      const reminder = state.snapshot.reminders.find((r) => r.id === payload.reminderId);
      if (reminder === undefined) {
        set({ error: `dismissAlarm: no Reminder with id "${payload.reminderId}"` });
        return;
      }
      // Monotonic guard — never regress a terminal state (a second dismiss or
      // a dismiss after a delete/cancel is a clean no-op, not an error path).
      if (reminder.state === "cleared" || reminder.state === "cancelled") {
        return;
      }
      const todo = state.snapshot.todos.find((t) => t.id === reminder.todoId);
      if (todo === undefined) {
        set({
          error: `dismissAlarm: no Todo for Reminder with id "${payload.reminderId}"`,
        });
        return;
      }
      try {
        const now = Date.now();
        const dismissedReminder = ReminderSchema.parse({
          ...reminder,
          state: "cleared",
          pendingPostRebootBanner: false,
          updatedAt: now,
          revision: reminder.revision + 1,
        });
        const completedTodo = TodoSchema.parse({
          ...todo,
          completed: true,
          completedAt: now,
          updatedAt: now,
          revision: todo.revision + 1,
        });
        set({
          snapshot: {
            ...state.snapshot,
            reminders: state.snapshot.reminders.map((r) =>
              r.id === dismissedReminder.id ? dismissedReminder : r,
            ),
            todos: state.snapshot.todos.map((t) => (t.id === completedTodo.id ? completedTodo : t)),
          },
          error: null,
        });
        persist();
        // Slice 9 — fire-and-forget recurrence scheduling (anchor='completed').
        void scheduleRecurrenceAsync(reminder, completedTodo, now);
      } catch (err) {
        set({ error: err instanceof z.ZodError ? err.message : String(err) });
      }
    });

    // Slice 6 — snooze (ADR 0007 Decision C): the no-password path. Reset the
    // Reminder `fired` → `pending` at `now + SNOOZE_INTERVAL_MS`, bump
    // `snoozeCount`, then cancel-then-schedule so the timer re-arms at the new
    // `triggerAt`. `scheduleIfArmed` only schedules `state === 'pending'`, so
    // the re-arm fires at the new time.
    void alarmAdapter.onAlarmSnoozed((payload: AlarmActionPayload) => {
      const state = get();
      const reminder = state.snapshot.reminders.find((r) => r.id === payload.reminderId);
      if (reminder === undefined) {
        set({ error: `snoozeAlarm: no Reminder with id "${payload.reminderId}"` });
        return;
      }
      const todo = state.snapshot.todos.find((t) => t.id === reminder.todoId);
      if (todo === undefined) {
        set({
          error: `snoozeAlarm: no Todo for Reminder with id "${payload.reminderId}"`,
        });
        return;
      }
      if (reminder.snoozeCount >= MAX_SNOOZES) {
        // Store-side guard for issue AC #6 — after the 3rd snooze the shell
        // drops the Snooze button; never mutate or re-arm past the cap.
        set({ error: "snoozeAlarm: snooze limit reached (MAX_SNOOZES)" });
        return;
      }
      try {
        const now = Date.now();
        const snoozedUntil = now + SNOOZE_INTERVAL_MS;
        const updatedReminder = ReminderSchema.parse({
          ...reminder,
          state: "pending",
          snoozedUntil,
          triggerAt: snoozedUntil,
          snoozeCount: reminder.snoozeCount + 1,
          updatedAt: now,
          revision: reminder.revision + 1,
        });
        set({
          snapshot: {
            ...state.snapshot,
            reminders: state.snapshot.reminders.map((r) =>
              r.id === updatedReminder.id ? updatedReminder : r,
            ),
          },
          error: null,
        });
        persist();
        cancelIfArmed(reminder.id);
        scheduleIfArmed(updatedReminder, todo);
      } catch (err) {
        set({ error: err instanceof z.ZodError ? err.message : String(err) });
      }
    });

    return {
      snapshot: EMPTY_SNAPSHOT,
      loaded: false,
      error: null,
      syncStatus: "idle",
      lastSyncResult: null,
      syncIntervalMinutes: 5,

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

      clearRebootBanner(reminderId: Reminder["id"]): void {
        const state = get();
        const reminder = state.snapshot.reminders.find((r) => r.id === reminderId);
        if (reminder === undefined) {
          set({ error: `clearRebootBanner: no Reminder with id "${reminderId}"` });
          return;
        }
        // Banner-dismissible iff flagged AND escaped-via-reboot per the
        // canonical `markRebootEscapes` matcher shape (drift-guard contract
        // with `src/persistence/markRebootEscapes.ts` + HomeView's filter): a
        // `fired` Reminder or a `pending` Reminder past its `triggerAt`. The
        // prior `state !== "fired"` guard silently no-op'd the past-due
        // pending branch exposed by issue #7's reboot-while-armed path.
        const now = Date.now();
        const escaped =
          reminder.state === "fired" || (reminder.state === "pending" && reminder.triggerAt <= now);
        if (!escaped || reminder.pendingPostRebootBanner !== true) {
          return; // no-op — nothing to dismiss.
        }
        try {
          const updated = ReminderSchema.parse({
            ...reminder,
            pendingPostRebootBanner: false,
            updatedAt: now,
            revision: reminder.revision + 1,
          });
          set({
            snapshot: {
              ...state.snapshot,
              reminders: state.snapshot.reminders.map((r) => (r.id === reminderId ? updated : r)),
            },
            error: null,
          });
          persist();
        } catch (err) {
          set({ error: err instanceof z.ZodError ? err.message : String(err) });
        }
      },

      createTodo(input: TodoInput): Todo {
        try {
          const now = Date.now();
          const assembledTodo: Todo = {
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
          const todo = TodoSchema.parse(assembledTodo);

          let newReminder: Reminder | null = null;
          if (todo.reminderId !== null && input.reminderTriggerAt !== null) {
            const assembledReminder: Reminder = {
              id: todo.reminderId as Reminder["id"],
              todoId: todo.id,
              triggerAt: input.reminderTriggerAt,
              recur: input.reminderRecur ?? null,
              state: "pending",
              snoozedUntil: null,
              snoozeCount: 0,
              pendingPostRebootBanner: false,
              permissionRefusedAt: null,
              recurredTo: null,
              createdAt: now,
              updatedAt: now,
              revision: 0,
            };
            newReminder = ReminderSchema.parse(assembledReminder);
          }

          set((state) => ({
            snapshot: {
              ...state.snapshot,
              todos: [...state.snapshot.todos, todo],
              reminders:
                newReminder === null
                  ? state.snapshot.reminders
                  : [...state.snapshot.reminders, newReminder],
            },
            error: null,
          }));
          persist();

          // After persist fire: schedule the timer. Idempotent on
          // reminder.id — re-scheduling overwrites the prior arming.
          scheduleIfArmed(newReminder, todo);
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
          let reminders = state.snapshot.reminders;

          const oldReminderId = existing.reminderId;
          const newReminderId = updated.reminderId;
          let newReminderForSchedule: Reminder | null = null;

          // Slice 6 — completing the Todo is the offline password-dismiss
          // equivalent (ADR 0007 C-extension). Runs BEFORE the retirement /
          // re-arm branches so a cleared Reminder carries `state: 'cleared'`
          // into `newReminderForSchedule` and `scheduleIfArmed` (pending-only)
          // refuses to re-arm it — no alarm re-fire after manual completion.
          // Slice 9 — also capture the old Reminder for async recurrence scheduling.
          const oldReminderForRecur =
            patch.completed === true
              ? state.snapshot.reminders.find((r) => r.todoId === id)
              : undefined;
          if (patch.completed === true) {
            cancelIfArmed(newReminderId);
            reminders = clearReminderOnCompletion(reminders, id, Date.now());
          }

          if (oldReminderId !== null && oldReminderId !== newReminderId) {
            // Reminder retired: cancel the timer, transition entity to 'cancelled'
            // (ADR 0006 — `cancelled` is terminal and survived for slice 7's
            // merge engine; slice 5 does not GC).
            cancelIfArmed(oldReminderId);
            reminders = reminders.map((r) =>
              r.id === oldReminderId
                ? ReminderSchema.parse({
                    ...r,
                    state: "cancelled",
                    updatedAt: Date.now(),
                    revision: r.revision + 1,
                  })
                : r,
            );
          }

          if (
            newReminderId !== null &&
            newReminderId !== oldReminderId &&
            patch.reminderTriggerAt !== undefined &&
            patch.reminderTriggerAt !== null
          ) {
            // Brand-new Reminder (different id from the previous): build the
            // entity, push it to the snapshot, schedule it.
            const now = Date.now();
            const assembled: Reminder = {
              id: newReminderId as Reminder["id"],
              todoId: updated.id,
              triggerAt: patch.reminderTriggerAt,
              recur: patch.reminderRecur ?? null,
              state: "pending",
              snoozedUntil: null,
              snoozeCount: 0,
              pendingPostRebootBanner: false,
              permissionRefusedAt: null,
              recurredTo: null,
              createdAt: now,
              updatedAt: now,
              revision: 0,
            };
            newReminderForSchedule = ReminderSchema.parse(assembled);
            reminders = [...reminders, newReminderForSchedule];
          } else if (
            newReminderId !== null &&
            newReminderId === oldReminderId &&
            patch.reminderTriggerAt !== undefined &&
            patch.reminderTriggerAt !== null
          ) {
            // Same Reminder entity — user changed dueAt or triggerAt — re-arm.
            // cancelAlarm + scheduleAlarm sequence preserves the "idempotent on
            // reminder.id" contract on AlarmAdapter.
            cancelIfArmed(newReminderId);
            const existingReminder = reminders.find((r) => r.id === newReminderId);
            if (existingReminder !== undefined) {
              const recur =
                patch.reminderRecur !== undefined ? patch.reminderRecur : existingReminder.recur;
              const updatedReminder: Reminder = ReminderSchema.parse({
                ...existingReminder,
                triggerAt: patch.reminderTriggerAt,
                recur,
                updatedAt: Date.now(),
                revision: existingReminder.revision + 1,
              });
              newReminderForSchedule = updatedReminder;
              reminders = reminders.map((r) => (r.id === newReminderId ? updatedReminder : r));
            }
          }

          const todos = state.snapshot.todos.map((t, i) => (i === idx ? updated : t));
          set({ snapshot: { ...state.snapshot, todos, reminders }, error: null });
          persist();

          if (newReminderForSchedule !== null) {
            scheduleIfArmed(newReminderForSchedule, updated);
          }
          // Slice 9 — fire-and-forget recurrence scheduling after completion.
          if (patch.completed === true && oldReminderForRecur !== undefined) {
            void scheduleRecurrenceAsync(oldReminderForRecur, updated, Date.now());
          }
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
        // Cancel any armed alarm + mark the Reminder entity cancelled (ADR 0006
        // — `cancelled` is terminal; slice 7's merge engine treats it as
        // monotonic over `cleared`).
        if (deleted.reminderId !== null) {
          cancelIfArmed(deleted.reminderId);
        }
        const now = Date.now();
        let reminders = state.snapshot.reminders;
        if (deleted.reminderId !== null) {
          reminders = reminders.map((r) =>
            r.id === deleted.reminderId
              ? ReminderSchema.parse({
                  ...r,
                  state: "cancelled",
                  updatedAt: now,
                  revision: r.revision + 1,
                })
              : r,
          );
        }
        const tombstone: Tombstone = {
          id: deleted.id,
          kind: "todo",
          deletedAt: now,
          snapshot: deleted,
        };
        const todos = state.snapshot.todos.filter((t) => t.id !== id);
        set({
          snapshot: {
            ...state.snapshot,
            todos,
            reminders,
            deleted: [...state.snapshot.deleted, tombstone],
          },
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
          const completing = !existing.completed;
          const updated = TodoSchema.parse({
            ...existing,
            completed: completing,
            completedAt: completing ? now : null,
            updatedAt: now,
            revision: existing.revision + 1,
          });
          let reminders = state.snapshot.reminders;
          // Capture the old reminder BEFORE mutation for recurrence scheduling.
          const oldReminder = state.snapshot.reminders.find((r) => r.todoId === id);
          if (completing && existing.reminderId !== null) {
            // ADR 0007 C-extension: completing = offline password-dismiss —
            // cancel the timer and clear the Reminder in the same mutation.
            cancelIfArmed(existing.reminderId);
            reminders = clearReminderOnCompletion(reminders, id, now);
          }
          const todos = state.snapshot.todos.map((t, i) => (i === idx ? updated : t));
          set({ snapshot: { ...state.snapshot, todos, reminders }, error: null });
          persist();
          // Slice 9 — fire-and-forget recurrence scheduling (anchor='completed').
          // Runs after set+persist so the cleared state is persisted first.
          if (completing && oldReminder !== undefined) {
            void scheduleRecurrenceAsync(oldReminder, updated, now);
          }
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

      async sync(remote: Snapshot): Promise<SyncResult> {
        const preReminders = get().snapshot.reminders;
        const result = await runSync(adapter, remote);
        if (result.ok) {
          set({ snapshot: result.merged, error: null, lastSyncResult: result });
          // Slice 8: cross-device alarm self-dismiss — if the merged snapshot
          // carries a Reminder whose state transitioned from fired to
          // cleared/cancelled (or the reminder was deleted), close the local
          // on-screen Alarm Event window.
          const postReminders = result.merged.reminders;
          for (const pre of preReminders) {
            if (pre.state !== "fired") continue;
            const post = postReminders.find((r) => r.id === pre.id);
            const terminal =
              post === undefined || post.state === "cleared" || post.state === "cancelled";
            if (terminal) {
              void alarmAdapter.closeAlarmWindow(pre.id).catch(() => {
                // Best-effort — the window may already be closed / unknown.
              });
            }
          }
        } else {
          set({ error: result.error ?? "Sync failed", lastSyncResult: result });
        }
        return result;
      },

      async revertLastMerge(): Promise<boolean> {
        const ok = await orchestratorRevertLastMerge(adapter);
        if (ok) {
          const snapshot = await adapter.loadSnapshot();
          set({ snapshot, error: null });
        }
        return ok;
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
  readHistoryFile: (filename) => resolveStoreAdapter().readHistoryFile(filename),
  appendHistoryFile: (filename, line) => resolveStoreAdapter().appendHistoryFile(filename, line),
};

function resolveAlarmAdapter(): AlarmAdapter {
  if (typeof window === "undefined") {
    return electronAlarmStub;
  }
  return window.cookietodoAlarmAdapter?.() ?? electronAlarmStub;
}

const lazyAlarmAdapter: AlarmAdapter = {
  scheduleAlarm: (reminder, todo) => resolveAlarmAdapter().scheduleAlarm(reminder, todo),
  cancelAlarm: (reminderId) => resolveAlarmAdapter().cancelAlarm(reminderId),
  onAlarmFired: (cb) => resolveAlarmAdapter().onAlarmFired(cb),
  requestPermission: (kind) => resolveAlarmAdapter().requestPermission(kind),
  dismissAlarm: (reminderId) => resolveAlarmAdapter().dismissAlarm(reminderId),
  snoozeAlarm: (reminderId) => resolveAlarmAdapter().snoozeAlarm(reminderId),
  closeAlarmWindow: (reminderId) => resolveAlarmAdapter().closeAlarmWindow(reminderId),
  onAlarmDismissed: (cb) => resolveAlarmAdapter().onAlarmDismissed(cb),
  onAlarmSnoozed: (cb) => resolveAlarmAdapter().onAlarmSnoozed(cb),
};

export const cookietodoStore: StoreApi<CookietodoStoreState> = createCookietodoStore(
  lazyStoreAdapter,
  lazyAlarmAdapter,
);
