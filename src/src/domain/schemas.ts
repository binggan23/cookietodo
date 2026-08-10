/**
 * Domain Zod schemas — single source of truth for the typed Store model
 * (ADR 0006). The JSON Snapshot (ADR 0001) serializes these; the Store
 * (slice 3) and the merge engine (slice 4+) derive all behavior from them.
 *
 * Field shapes are verbatim from ADR 0006 §"Decision — type definitions".
 *
 * IMPORTANT drift guards:
 *   - `snoozeCount` and `pendingPostRebootBanner` both live on `Reminder` per
 *     ADR 0007 Consequences ("New field `snoozeCount: number` (default 0) on
 *     `Reminder`") and issue #7 AC #7 (the reboot-escape banner flag).
 *     `snoozedUntil` remains a separate scheduling field beside them.
 *   - `anchor` lives on `Recurrence`, not on `Todo`.
 *   - IDs are ULID (Crockford base32, 26 chars, sortable). `ulid()` from the
 *     `ulid` package is the runtime minting function; this module only
 *     validates the format — it never generates IDs (Store does that).
 *   - `Todo.reminderId != null ⟹ Todo.dueAt != null` is enforced at the Zod
 *     boundary via `TodoSchema.superRefine` (ADR 0006 Todo.dueAt row).
 *   - All TS types are derived via `z.infer<...>` in `./types.ts`; never
 *     hand-write a parallel TS interface (exactOptionalPropertyTypes would
 *     silently diverge).
 *
 * Zod 4 (v4.4.x) note: `z.strictObject(...)` is the canonical strict-mode
 * factory; `.strict()` is legacy. `.catchall(z.unknown())` is the
 * forward-compat surface per ADR 0001.
 */
import * as z from "zod";

/** ULID format: 26 chars of Crockford base32 (excludes I/L/O/U). */
export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** `#RRGGBB` hex (lower or upper case). `null` allowed → use `.nullable()`. */
export const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** Epoch milliseconds, non-negative integer (always within safe-int range). */
export const epochMs = z.number().int().nonnegative();

/** ULID-typed identifier. */
export const IdSchema = z.string().regex(ULID_RE);

/** `Recurrence` per ADR 0006. Skeleton this slice — no scheduling logic. */
export const RecurrenceSchema = z.strictObject({
  kind: z.enum(["daily", "weekly", "monthly"]),
  interval: z.number().int().positive(),
  weekdayMask: z.number().int().min(0).max(127).nullable(),
  daysOfMonth: z.array(z.number().int()).nullable(),
  nthWeekday: z
    .array(
      z.strictObject({
        weekday: z.number().int().min(0).max(6),
        n: z
          .number()
          .int()
          .refine((v) => v !== 0, { message: "nth-weekday n must be nonzero" }),
      }),
    )
    .nullable(),
  count: z.number().int().positive().nullable(),
  until: epochMs.nullable(),
  /** 'completed' = "every!" / "when done" semantics (ADR 0006). */
  anchor: z.enum(["due", "completed"]),
});

/** `Reminder` per ADR 0006 (skeleton — scheduling lands in slice 5+). */
export const ReminderSchema = z.strictObject({
  id: IdSchema,
  todoId: IdSchema,
  triggerAt: epochMs,
  recur: RecurrenceSchema.nullable(),
  state: z.enum(["pending", "fired", "cleared", "cancelled"]),
  snoozedUntil: epochMs.nullable(),
  snoozeCount: z.number().int().nonnegative().default(0),
  pendingPostRebootBanner: z.boolean().default(false),
  permissionRefusedAt: epochMs.nullable(),
  recurredTo: IdSchema.nullable(),
  createdAt: epochMs,
  updatedAt: epochMs,
  revision: z.number().int().nonnegative(),
});

/** `Todo` per ADR 0006. `reminderId != null ⟹ dueAt != null` enforced below. */
export const TodoSchema = z
  .strictObject({
    id: IdSchema,
    title: z.string().max(200),
    notes: z.string(),
    listIds: z.array(IdSchema),
    completed: z.boolean(),
    completedAt: epochMs.nullable(),
    dueAt: epochMs.nullable(),
    reminderId: IdSchema.nullable(),
    createdAt: epochMs,
    updatedAt: epochMs,
    revision: z.number().int().nonnegative(),
  })
  .superRefine((todo, ctx) => {
    if (todo.reminderId !== null && todo.dueAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Todo.reminderId != null requires Todo.dueAt != null — a Reminder cannot exist without a dueAt (ADR 0006).",
        path: ["dueAt"],
      });
    }
  });

/** `List` per ADR 0006. */
export const ListSchema = z.strictObject({
  id: IdSchema,
  name: z.string().max(80),
  color: z.string().regex(HEX_COLOR_RE).nullable(),
  createdAt: epochMs,
  updatedAt: epochMs,
  revision: z.number().int().nonnegative(),
});

/**
 * Tombstone (slice-3 deletion record per ADR 0004). The discriminated union on
 * `kind` guarantees the `snapshot` payload matches the declared entity type.
 * GC (TTL enforcement) lands in slice 7 — slice 3 retains tombstones
 * indefinitely; the recently-deleted UI surfaces them by `deletedAt`.
 */
export const TombstoneSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    id: IdSchema,
    kind: z.literal("todo"),
    deletedAt: epochMs,
    snapshot: TodoSchema,
  }),
  z.strictObject({
    id: IdSchema,
    kind: z.literal("list"),
    deletedAt: epochMs,
    snapshot: ListSchema,
  }),
]);

/**
 * `Snapshot` — the serializable image of the Store (ADR 0001). Persists to
 * `snapshot.json` via {@link StoreAdapter} (ADR 0003). Round-trips across
 * Sync as the reconciliation unit (ADR 0004 — slice 4+).
 *
 * Type rules:
 *   - `.strict()`-equivalent via `z.strictObject`: unknown top-level keys
 *     are rejected (strict-JSON export per ADR 0001).
 *   - `.catchall(z.unknown())`: forward-compat — keys a newer app emits that
 *     an older app does not recognize are preserved through a round-trip
 *     (ADR 0001 consequence: "additive fields are naturally tolerated").
 *   - `.default([])` on each collection: an empty or older Snapshot loads
 *     cleanly into a newer app (ADR 0001 back-compat).
 *
 * The `schemaVersion: 1` literal is the migration anchor (ADR 0001 reserves
 * future `.todo.json` zip-container; this key is independent of that).
 */
export const SnapshotSchema = z
  .strictObject({
    todos: z.array(TodoSchema).default([]),
    lists: z.array(ListSchema).default([]),
    reminders: z.array(ReminderSchema).default([]),
    deleted: z.array(TombstoneSchema).default([]),
    schemaVersion: z.literal(1).default(1),
  })
  .catchall(z.unknown());
