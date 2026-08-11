/**
 * `StoreAdapter` — the persistence contract (ADR 0003).
 *
 * One TS interface reads/writes the Snapshot bytes. The Store (slice 3+)
 * calls only this interface; it never knows whether the bytes sit in
 * IndexedDB, Capacitor `Filesystem.readFile`, or Node `fs.promises`.
 *
 * Implementations:
 *   - {@link apps/electron/main/ElectronStoreAdapter} — desktop, Node `fs`
 *     against `app.getPath('userData')/snapshot.json`. Atomic write via
 *     write-tmp + fsync + rename (ADR 0003).
 *   - apps/android/CapacitorStoreAdapter (slice 10) — Capacitor Filesystem
 *     against app-private external storage.
 *   - {@link ./MemoryStoreAdapter} — in-memory stub for renderer/Vitest
 *     headless and for the no-preload fallback path (mirrors the slice-2
 *     `electronRendererStub`).
 *
 * Slice 3 implements only `loadSnapshot` / `saveSnapshot`. The
 * `importSnapshot` / `exportSnapshot` methods are typed-but-stubbed on the
 * interface for forward-compat (Import/Export UI lands in a later slice);
 * implementations throw `not-implemented` (e.g. {@link MemoryStoreAdapter}).
 *
 * PUBLIC SURFACE: `@cookietodo/renderer/persistence` (`../../package.json`).
 */
import type { Snapshot } from "../domain/types";

/**
 * Persistence adapter — bytes-in / bytes-out for one Snapshot.
 *
 * Every method is async because the desktop backend goes through the
 * main-process IPC (`ipcRenderer.invoke` in the renderer-side proxy), and
 * the Android backend goes through Capacitor's promise-based Filesystem
 * plugin; both return Promises. `MemoryStoreAdapter` wraps synchronous
 * mutations in `Promise.resolve` to match the contract shape.
 */
export interface StoreAdapter {
  /**
   * Read the persisted Snapshot. Missing / unreadable / malformed store
   * returns the empty Snapshot (per ADR 0003 first-launch path); the
   * implementation re-validates the bytes through {@link SnapshotSchema}
   * before returning (parse-don't-validate).
   */
  loadSnapshot(): Promise<Snapshot>;
  /**
   * Persist a Snapshot. Whole-file rewrite (ADR 0003 — re-write is
   * whole-file on every save; acceptably cheap for a personal todo tool).
   * Implementations MUST write atomically (write-tmp + fsync + rename).
   */
  saveSnapshot(snapshot: Snapshot): Promise<void>;
  /**
   * Import a user-supplied file. JSONC-tolerant per ADR 0001. Out of scope
   * for slice 3 — implementations throw `not-implemented`; the typed method
   * stays on the interface for Import/Export UI in a later slice.
   */
  importSnapshot(file: File): Promise<Snapshot>;
  /**
   * Export the current Snapshot to a `.todo.json` file per ADR 0001.
   * Out of scope for slice 3 — implementations throw `not-implemented`.
   */
  exportSnapshot(): Promise<File>;
  /**
   * Read a logical file from the store's data directory (e.g.
   * `snapshot.history.jsonl`). Missing file returns `null`.
   * Slice 7 — sync history.
   */
  readHistoryFile(filename: string): Promise<string | null>;
  /**
   * Append a line to a logical file in the store's data directory.
   * Slice 7 — sync history (append-only JSONL).
   */
  appendHistoryFile(filename: string, line: string): Promise<void>;
}
