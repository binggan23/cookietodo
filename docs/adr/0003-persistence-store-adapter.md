# ADR 0003: Persistence is one TS interface (`StoreAdapter`) backed by Capacitor Filesystem on Android and Node `fs` on desktop

**Date**: 2026-07-28
**Status**: Accepted

## Context

ADR 0001 locked `Snapshot` as a JSON file (JSONC-tolerant on Import). Q5 (2026-07-28 grilling) accepted a single pnpm monorepo where TS owns U + SL + a `StoreAdapter` interface, and the two native shells (Electron desktop, Capacitor Android) each implement that interface. Q6 settled **which** backing technology the Android implementation uses. This ADR records that decision and leaves no ambiguity about where the Snapshot physically lives on either platform.

## Decision

- **One TS interface** `src/persistence/StoreAdapter.ts` — `loadSnapshot(): Promise<Snapshot>` / `saveSnapshot(s: Snapshot): Promise<void>` / `importSnapshot(file: File): Promise<Snapshot>` / `exportSnapshot(): Promise<File>`. The Store calls only this interface; it never knows whether the bytes are sitting in a IndexedDB row, in a `Filesystem.readFile`, or in a Node fs path.
- **Desktop implementation** (`apps/electron/main/ElectronStoreAdapter.ts`): `Node.fs.promises.readFile` / `writeFile` against `app.getPath('userData')/snapshot.json` (strict JSON per ADR 0001 export side). Import tolerant to JSONC via `jsonc-parser`. Re-write is whole-file on every save (no incremental shadowing) — acceptably cheap for a personal todo tool.
- **Android implementation** (`apps/android/CapacitorStoreAdapter.ts`): the `@capacitor/filesystem` plugin reads/writes `snapshot.json` in the app-specific external storage directory (no runtime permission required on Android 14). All Snapshot bytes are a single JSON file, same as desktop, mobile only differs in which `readFile`/`writeFile` API backs the contract.
- **Import/Export plumbing**: Import consumes a JSON-tolerant file the user picked (File picker on desktop, SAF-Intent via `@capacitor/filesystem` `Filesystem.readFile` on Android); parsing flows through the JSONC parser from ADR 0001. Export writes a strict-JSON file (deterministic key order via `z.object({...}).strict()` from ADR 0001) to a path the user shares via `@capacitor/share` (Android) or `dialog.showSaveDialog` (desktop). Both shells share `src/snapshot/` parser and serializer code.

## Rationale

- **ADR 0001 self-consistency**: Snapshot is a JSON *file* by decision; therefore storage physically is a file. Going IndexedDB would mean "Snapshot is a file → I store it inside an IndexedDB BLOB → Import/Export has to flatten it back to a file", one layer of glue whose only justification would have been performance, which ADR 0001 already accepted as a non-issue at v1's scale.
- **Symmetry across shells**: Electron already does Node fs → JSON file. Capacitor Filesystem makes Android do the same shape. Both shells implement the same TS contract identity.
- **Webview durability concerns**: IndexedDB across Capacitor major-version upgrades has community-tracked data-loss incidents (where webview state is reset); a file in app-private storage survives the same upgrade cleanly. For a todo tool where the user's data is the value of the product, this asymmetry biases the choice toward Filesystem.
- **Performance non-blocker**: a personal todo Snapshot is realistically < 100 KB; whole-file `readFile` + `JSON.parse` measures `< 5ms` routinely. Optimizing for O(log n) reads is premature at v1.
- **Permission non-blocker**: app-specific external storage requires no runtime permission on Android 14 (`READ_MEDIA_*` permissions only attach to shared media collections, not app-private dirs). This ADR does not intersect with ADR 0002's permission story.

## Consequences

- The `Store` (in-scope SL per Q5) is persistence-agnostic; persistence lives only behind `StoreAdapter`. New shells (hypothetical iOS later) only implement `StoreAdapter`, not the Store.
- Whole-file re-write on every save means writes scale O(n) with todo count. v1 budget is "personal todo list" (~thousands of todos at most). A future ADR reserved to specify an IndexedDB cache layer in front of Filesystem if performance becomes live.
- Implementations must guard `writeFile` atomically — write to `snapshot.json.tmp`, fsync, rename to `snapshot.json`. On Android rename is atomic within app-private storage; on desktop POSIX `rename(2)` is atomic on same filesystem, equivalent on Win32 via `MoveFileEx` with `MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH`.
- Snapshot-on-disk is strict JSON (no comments, deterministic key order from `z.object(...).strict()`); import accepts JSONC; the JSONC parser lives in `src/snapshot/parse.ts` and is shared by both shells.
- Out of scope here: backup rotation (multiple `snapshot.YYYYMMDD.json` versions kept by the app for undo), versioning under Sync's reconciliation. Sealed for v1; backup rotation is a candidate for a future ADR.
- Out of scope here: encryption at rest. v1 Snapshot is plain JSON; if requested later, encryption becomes a transparent transform inside each `StoreAdapter` implementation and does not break the interface.
