# ADR 0006: Domain model — Todo / List / Reminder / Recurrence field shapes and per-field merge semantics

**Date**: 2026-07-28
**Status**: Accepted

## Context

ADR 0004 committed to "field-level 3-way merge" but left field shapes abstract. This ADR nails the four domain types — `Todo`, `List`, `Reminder`, `Recurrence` — and assigns each field a specific merge semantic so that ADR 0004's merge algorithm can be implemented without further design decisions.

Findings from the 2026-07-28 research dispatch (librarian, between this ADR and Q9 of grilling):

- Real todo apps (Todoist, TickTick, Things 3, Obsidian Tasks) **store notes as raw Markdown strings and resolve cross-device note conflicts as last-writer-wins**. None do block- or CRDT-level merge for a note body in a personal tool.
- **No major consumer todo app exposes raw RRULE in its UI** — every one hides recurrence behind custom dialogs and, when storing RRULE, extends it (`TickTick`'s `TT_SKIP`, `TT_WORKDAY` are the proof that RRULE alone is insufficient even for sophisticated apps). The custom `{kind, interval, weekdayMask, daysOfMonth, nthWeekday, count, until, anchor}` model aligns with what real apps expose to UIs.
- `@rrule/r rule` (fork) ships pure ESM, works in both Capacitor WebView and Electron with no Node deps; use it at fire-time to compute `triggerAt`, **do not store RRULE strings** in the Snapshot.
- `anchor: 'due' | 'completed'` is required by the standard "repeat after done" model used by Todoist (`every!`) and Obsidian Tasks (`when done`); omitting it forces a stored-data migration later.

## Decision — type definitions

```ts
type ID = string; // ULID

interface Todo {
  id: ID;
  title: string;            // max 200 chars
  notes: string;            // Markdown, plain string; NOT block-AST, NOT CRDT
  listIds: ID[];            // many-to-many to List; Todo owns the relation
  completed: boolean;
  completedAt: number | null;
  dueAt: number | null;     // epoch ms; REQUIRED when reminderId is non-null — a Reminder cannot exist without a dueAt
  reminderId: ID | null;    // a Todo owns at most one Reminder; relation is held here
  createdAt: number;       // epoch ms, immutable
  updatedAt: number;       // epoch ms, bumped on every mutation touching top-level fields
  revision: number;        // monotonic per-Store
}

interface List {
  id: ID;
  name: string;            // max 80
  color: string | null;    // '#RRGGBB' or null; UI default when null
  createdAt: number;
  updatedAt: number;
  revision: number;
}

interface Reminder {
  id: ID;
  todoId: ID;
  triggerAt: number;               // epoch ms; next UTC fire time
  recur: Recurrence | null;
  state: 'pending' | 'fired' | 'cleared' | 'cancelled';
  snoozedUntil: number | null;     // when set, the UI has snoozed; state goes back to 'pending' and triggerAt moves to snoozedUntil
  permissionRefusedAt: number | null; // epoch ms of refusal timestamp on the device that refused; cross-Sync is monotonic (any-side non-null makes both sides non-null)
  recurredTo: ID | null;            // next Reminder's id when recurrence fires; written atomically by the device that fired the previous one
  createdAt: number;
  updatedAt: number;
  revision: number;
}

interface Recurrence {
  kind: 'daily' | 'weekly' | 'monthly';
  interval: number;                // >= 1
  weekdayMask: number | null;      // 0-127 bit, bit 1 = Sunday .. bit 7 = Saturday
  daysOfMonth: number[] | null;    // positives + negatives (-1 = last day of month)
  nthWeekday: { weekday: number; n: number }[] | null; // e.g. "2nd Tuesday" = { weekday: 2, n: 2 }
  count: number | null;            // bounded recurrence
  until: number | null;             // bounded recurrence — epoch ms
  anchor: 'due' | 'completed';      // 'completed' = "every!"/"when done" semantics
}
```

The typed Store model is defined as Zod `z.object({...}).strict()` schemas in `src/domain/`. The Snapshot persistence types (ADR 0001) derive from these.

## Decision — per-field merge semantics

The field name is in `()`; the merge semantic is on the right.

### Todo

| Field | Merge semantic |
|---|---|
| `id` | constant — never merged |
| `title` | scalar 3-way LWW per `updatedAt` |
| `notes` | scalar LWW — whole-string replace, no block-level merge. Two-sided concurrent note edits lose one side; recoverable via Snapshot history (ADR 0004) |
| `listIds` | **set union-with-diff**: commonAncestor is base; additions from each side union in, deletions from each side diff out; on add/delete conflict the addition wins (prevents data loss from unilateral delete) |
| `completed` | **monotonic-or**: true if either side set true; regressing to false requires commonAncestor true AND both sides set false |
| `completedAt` | coupled to `completed` — write `now` on flip to true, `null` on flip to false |
| `dueAt` | scalar 3-way LWW. **REQUIRED (non-null) when `reminderId` is non-null** — a Reminder cannot exist without a dueAt; creating a Reminder on a Todo with null dueAt is rejected at the Zod validation boundary |
| `reminderId` | treated as FK only; resolution happened on the Reminder table (see Reminder) |
| `createdAt` | constant |
| `updatedAt` | LWW sort key |
| `revision` | per-Store monotonic; not merged across devices |

### List

| Field | Merge semantic |
|---|---|
| `id`, `createdAt` | constants |
| `name` | scalar 3-way LWW |
| `color` | scalar 3-way LWW |
| `updatedAt` | LWW sort key |
| `revision` | per-Store monotonic |

`todoIds` inverse field is **not** stored on List. The many-to-many relation is owned only by `Todo.listIds`. UI queries that need "Todos in List X" compute the inverse via a derived view / index, never persisted.

### Reminder

| Field | Merge semantic |
|---|---|
| `id`, `todoId`, `createdAt` | constants |
| `triggerAt` | scalar 3-way LWW; the scheduling device rewrites it when recurrence advances |
| `recur` | nested-object 3-way — each child field merges per its own semantic below |
| `state` | **state-machine merge** (see table below) — not LWW |
| `snoozedUntil` | scalar 3-way LWW |
| `permissionRefusedAt` | cross-Sync monotonic: any-side-non-null wins both sides |
| `recurredTo` | FK to next Reminder; treated as id field with scalar LWW (the firing device is the single writer) |
| `updatedAt`, `revision` | as above |

### Recurrence

| Field | Merge semantic |
|---|---|
| `kind` | enum 3-way LWW |
| `interval` | scalar 3-way LWW |
| `weekdayMask` | scalar 3-way LWW |
| `daysOfMonth` | set union-with-diff |
| `nthWeekday` | set union-with-diff (each `{weekday, n}` pair is a set element) |
| `count` | scalar 3-way LWW |
| `until` | scalar 3-way LWW |
| `anchor` | enum 3-way LWW |

### Reminder state-machine merge

`Left \ Right` table; the cell is the resulting state:

| Left \ Right | pending | fired | cleared | cancelled |
|---|---|---|---|---|
| **pending** | pending | fired | cleared | cancelled |
| **fired** | fired | fired | cleared | cancelled |
| **cleared** | cleared | cleared | cleared | cancelled |
| **cancelled** | cancelled | cancelled | cancelled | cancelled |

Rules inlined:
- `fired` > `pending` (a fired alarm is not reverted to pending by another device's stale pending state)
- `cleared` is monotonic (once cleared, only `cancelled` can further transition — i.e. user later cancels the recurrence entirely)
- `cancelled` is a terminal state (a user-driven cancel wins over any local action)

### `listIds` asymmetry — addition-wins rule

When one side adds List X to `listIds` and the other side removes List X from `listIds` (touching the same List X membership):
- addition wins (List X remains in `listIds`)
- A dismiss UX would let the user re-remove after merge; data loss from unilateral delete without consent is prevented

## Rationale

- **`notes` is LWW, not block-level**: matches real todo app behaviour; block-level merge turns a todo tool into a collaborative editor — out of scope for v1. Two-sided concurrent note edits lose one side; the user's recourse is the Snapshot history retention (`snapshot.history.jsonl`).
- **`listIds` is set, not LWW array**: simultaneous edits adding the same todo to two different lists both succeed. LWW would silently drop one side's addition, which the user experiences as silent data loss.
- **`completed` is monotonic-or**: completion is a one-way fact; once either device records it true, the todo stays completed. Uncompleting is a deliberate action requiring both sides to have explicitly unmarked.
- **`Reminder.state` is a state machine, not LWW**: an alarm that fired (fired) cannot be silently reverted to pending by another device's stale pending — that would let a second device whose pending state is older "undo" the user's dismissal on the first device.
- **`permissionRefusedAt` is cross-Sync monotonic**: the device that refused is the only writer of the `null` clearing (re-asks the user via ADR 0002's contextual-lazy path on its own). Other devices' stale `null`s do not undo the refusal because they did not observe the user's denial.
- **`Recurrence` is not stored as RRULE**: library evidence shows every sophisticated app extends RRULE (`TickTick` `TT_SKIP`/`TT_WORKDAY`) — embedding RRULE in the Snapshot would force a re-parse on every permission-check path and make field-level merge impossible (the entire RRULE string would be the LWW field). The custom `Recurrence` object exposes typed leaves that merge trivially; `@rrule/r rule` is invoked only at fire-time to compute the next `triggerAt`.

## Consequences

- The Store types module (`src/domain/types.ts`) and Zod schemas (`src/domain/schemas.ts`) are the single source of truth feeding both UI and persistence; the JSON Snapshot (ADR 0001) serializes these.
- The merge engine (`src/sync/merge.ts`) must implement three merge primitives: scalar-3way-LWW, set-union-with-diff, and the Reminder state-machine table. RPC primitives are not abstracted beyond what's needed.
- UIDs are ULID-format (sort by creation time on disk; lexicographic ordering usable for ordering display).
- Title (max 200) and List.name (max 80) are validated by Zod `z.string().max(N)` — they are enforced at the UI input layer as well as on Import.
- An in-app recurrence scheduler writes `triggerAt` (recomputed using rrule.js projected from `Recurrence`), and after firing writes `recurredTo` (a new ULID for the next reminder in the recurrence chain). Multiple devices must not each independently schedule the next reminder; the device that fires is the writer of `recurredTo`. Cross-Sync conflict on `recurredTo` is tolerated as scalar LWW with the device's own `updatedAt` as the sort key — a stale device that fails to fire (e.g. powered off) sees the next reminder recorded by the firing device and adjusts.
- Out of scope: block-level note merge, CRDT-backed note body, Yjs/Loro integration. The `notes` field is documented as LWW and that property is a v1 floor.
- Out of scope: recurrence beyond daily / weekly / monthly (no BYMONTH, BYYEARDAY, BYWEEKNO, RDATE/EXDATE). If advanced patterns are requested, ADR to extend.
- The `anchor: 'completed'` mode requires the scheduler to compute the next `triggerAt` from the moment of completion, not `triggerAt`. Behavior in the scheduler is documented in `src/alarm/scheduler.ts`.
