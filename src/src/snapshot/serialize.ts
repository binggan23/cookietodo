/**
 * Strict-JSON Snapshot serializer (ADR 0001 Export side).
 *
 * `serializeSnapshot(snapshot)` returns canonical strict JSON — 2-space indent,
 * deterministic key order, no comments, no trailing commas — so two exports
 * of the same data produce byte-identical files irrespective of mutation order
 * (prerequisite for the canonical round-trip test in slice 4's e2e seam).
 *
 * Canonicalization strategy:
 *   `JSON.stringify(snapshot, null, 2)`
 *
 * ES2015+ OwnProperty iteration order (TC39 §6.1.7.1) guarantees own
 * enumerable STRING keys iterate in insertion order (number-like keys
 * sort numerically first then strings; Snapshot is keyed by ULID strings
 * only, so the numeric-prefix trap does not apply). Snapshot is constructed
 * bottom-up through Zod-strictified schemas (`z.strictObject(...)`) in
 * stable file order (`todos`, `lists`, `reminders`, `deleted`,
 * `schemaVersion`), so the round-trip is byte-stable.
 *
 * ADR 0001 Rationale "Export is `JSON.stringify(snapshot, null, 2)` — strict,
 * stable key order" rests on this guarantee. If a future slice restructures
 * the in-memory Snapshot shape (e.g. ID-keyed `Map` → array) the
 * canonicalization assumption here MUST be re-validated; if keys can be
 * reordered post-load, swap `JSON.stringify` for a stable-stringify pass and
 * re-baseline the round-trip e2e.
 *
 * Re-export entry; no behavior. The renderer + main both consume this module
 * so the same canonical bytes flow through Export, Save, and the future manual
 * Sync transport (slice 7).
 *
 * PUBLIC SURFACE: `@cookietodo/renderer/snapshot/serialize`
 * (see `../../package.json` `exports` map entry).
 */
import { type Snapshot, SnapshotSchema } from "../domain/types";

/**
 * Serialize a {@link Snapshot} into canonical strict-JSON bytes.
 *
 * Re-validates through {@link SnapshotSchema} before serialization — parses
 * an already-typed value is pure + cheap, defends in depth against a caller
 * that mutated the snapshot object post-`load` (parse-don't-validate at the
 * I/O boundary, mirroring {@link ../persistence/MemoryStoreAdapter}).
 */
export function serializeSnapshot(snapshot: Snapshot): string {
  // Re-parse so an externally-mutated (unknown-key-stripped) snapshot throws
  // here, not at the reader of the exported file. `.catchall(z.unknown())`
  // on SnapshotSchema means forward-compat unknown keys survive this round-trip.
  const validated = SnapshotSchema.parse(snapshot);
  return JSON.stringify(validated, null, 2);
}
