/**
 * Domain types barrel — single source of truth for the typed Store model
 * (ADR 0006). All TS types are derived from the Zod schemas in `./schemas.ts`
 * via `z.infer<...>`; never hand-write a parallel TS interface
 * (`exactOptionalPropertyTypes` would silently diverge on nullable-vs-optional
 * fields — deriving from Zod side-steps the whole class of bugs).
 *
 * Re-exports the schemas themselves so callers may parse inputs against them
 * (Store mutations do parse-don't-validate).
 *
 * Public surface: `@cookietodo/renderer/domain` (see `../../package.json`
 * `exports` map).
 */
import type * as z from "zod";

import type {
  ListSchema,
  RecurrenceSchema,
  ReminderSchema,
  SnapshotSchema,
  TodoSchema,
  TombstoneSchema,
} from "./schemas";

/** ULID-typed identifier (26-char Crockford base32). */
export type Id = z.infer<typeof TodoSchema>["id"];

/** `Todo` per ADR 0006. */
export type Todo = z.infer<typeof TodoSchema>;
/** `List` per ADR 0006. */
export type List = z.infer<typeof ListSchema>;
/** `Reminder` per ADR 0006 (skeleton — scheduling lands in slice 5+). */
export type Reminder = z.infer<typeof ReminderSchema>;
/** `Recurrence` per ADR 0006. */
export type Recurrence = z.infer<typeof RecurrenceSchema>;
/**
 * Tombstone for slice-3 deletion. Discriminated union on `kind`; the
 * `snapshot` payload shape is type-coupled to `kind`.
 */
export type Tombstone = z.infer<typeof TombstoneSchema>;
/**
 * `Snapshot` — the serializable image of the Store (ADR 0001). `unknown`
 * catchall key set is permitted by the {@link SnapshotSchema} for forward
 * compatibility; the typed accessor surface here covers only the known keys.
 */
export type Snapshot = z.infer<typeof SnapshotSchema>;

/** Schemas, for callers that need to parse inputs against the contracts. */
export {
  epochMs,
  HEX_COLOR_RE,
  IdSchema,
  ListSchema,
  RecurrenceSchema,
  ReminderSchema,
  SnapshotSchema,
  TodoSchema,
  TombstoneSchema,
  ULID_RE,
} from "./schemas";
