# ADR 0001: Snapshot format is JSON (JSONC-tolerant on Import)

**Date**: 2026-07-28
**Status**: Accepted

## Context

The app has a `Snapshot` object — the serializable representation of the Store — used by two flows that must use the *same* shape:

1. **Import/Export**: the user moves their own data in and out of their own instances of the app (decision: scope is "my data in my app", not external-tool interop — see Q2 of grilling session 2026-07-28).
2. **Sync**: the unit that crosses the reconciliation channel between devices' Stores.

JSON vs XML was raised. The decision is hard to reverse after v1 ships because: (a) any exported file already in users' hands is a migration commitment; (b) Sync conflict resolution is shaped by the data model's diffability, which is format-coupled.

## Decision

**Snapshot is JSON.** Import is tolerant of JSONC (comments, trailing commas) so a user who hand-edits an export does not break the round-trip. Export emits strict JSON (no comments, no trailing commas) for tool-friendliness.

## Rationale

- TS-native: `structuredClone` + `JSON.stringify` round-trips the typed Store objects; the Zod/Valibot schema that validates the Store also validates the Snapshot, with no second schema to maintain.
- Line-diff maps cleanly to object-diff — the simplest possible shape for the future Sync merge.
- Schema evolution: additive fields are naturally tolerant; `z.catchall(z.unknown())` absorbs unknown keys from a newer export for forward-compatibility.
- XML's only real wins here (human-editable-with-comments; interop with an XML standard) do not apply: there is no live XML standard for todo+alarm (iCalendar is .ics, not XML, and is out of scope per Q2 answer "A"), and JSONC tolerance covers the human-edit case at a fraction of the cost of switching formats.
- Attachments (rich notes, images, alarm sounds) will eventually bloat payloads. The fix is not XML — it is a zip container with JSON for structure and sibling files for binary blobs. That decision is deferred until attachments actually exist; v1 ships pure JSON.

## Consequences

- Import parser must accept JSONC (use `jsonc-parser` or `json5` for tolerant parsing; reject nothing that `JSON.parse` would have produced).
- Export is `JSON.stringify(snapshot, null, 2)` — strict, stable key order (the Store types use `z.object({...}).strict()` so key order is deterministic).
- Forward-compat: the Zod schema uses `.catchall(z.unknown())` so unknown keys from a newer version survive a round-trip (preserved on re-export).
- Backward-compat: missing keys on an older Snapshot default via Zod `.default(...)` on each field — an old export imports cleanly into a newer app.
- File extension for v1: `.todo.json`. Reserved upgrade path: `.todo` (zip container) will hold one `snapshot.json` + `<blob>/...` when attachments land.
- Out of scope: any mapping to RFC 5545 iCalendar / VTODO / VALARM. If interop is needed later, that is a separate export target, not a Snapshot format change.
