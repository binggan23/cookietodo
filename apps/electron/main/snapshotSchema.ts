/**
 * Main-process-local Snapshot schema for `ElectronStoreAdapter`.
 *
 * Reason: Electron main is compiled separately from the renderer package.
 * Type-only imports from `@cookietodo/renderer/*` erase cleanly, but runtime
 * imports like `SnapshotSchema` would resolve to raw `.ts` files at runtime.
 * This local copy keeps ADR 0003 load validation working until a later slice
 * adds a proper renderer-domain JS build artifact.
 *
 * Drift guard: canonical field definitions live in `src/src/domain/schemas.ts`.
 * Keep this file in lockstep when ADR 0006 schemas change.
 */
import * as z from "zod";

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const epochMs = z.number().int().nonnegative();

const IdSchema = z.string().regex(ULID_RE);

const RecurrenceSchema = z.strictObject({
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
  anchor: z.enum(["due", "completed"]),
});

const ReminderSchema = z.strictObject({
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

const TodoSchema = z
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
        message: "Todo.reminderId != null requires Todo.dueAt != null (ADR 0006).",
        path: ["dueAt"],
      });
    }
  });

const ListSchema = z.strictObject({
  id: IdSchema,
  name: z.string().max(80),
  color: z.string().regex(HEX_COLOR_RE).nullable(),
  createdAt: epochMs,
  updatedAt: epochMs,
  revision: z.number().int().nonnegative(),
});

const TombstoneSchema = z.discriminatedUnion("kind", [
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

export const SnapshotSchema = z
  .strictObject({
    todos: z.array(TodoSchema).default([]),
    lists: z.array(ListSchema).default([]),
    reminders: z.array(ReminderSchema).default([]),
    deleted: z.array(TombstoneSchema).default([]),
    schemaVersion: z.literal(1).default(1),
  })
  .catchall(z.unknown());

export type Snapshot = z.infer<typeof SnapshotSchema>;
