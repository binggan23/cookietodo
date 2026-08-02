/**
 * `SettingsAdapter` — the Import/Export affordance contract (ADR 0001 + ADR 0003).
 *
 * Slice 4 first-class user flow: tap Export → save strict-JSON `.todo.json`
 * to disk; tap Import → pick a JSON or JSONC file, parse it through
 * `src/snapshot/parse.ts`, validate against Zod `Snapshot`, on success the
 * renderer replaces the in-memory Store + persists the new Snapshot atomically
 * via `StoreAdapter.saveSnapshot()` (ADR 0003 atomic-write).
 *
 * Why this is a separate interface from `StoreAdapter`:
 *   - `StoreAdapter` is bytes-in / bytes-out for ONE Snapshot locally
 *     (`loadSnapshot` / `saveSnapshot`). The Import/Export flow crosses the
 *     user's filesystem boundary via NATIVE OS dialogs (`dialog.showSaveDialog`
 *     on Electron, SAF Intent on Android via Capacitor) — a different
 *     surface with shell-specific UX. Coupling dialog plumbing onto
 *     `StoreAdapter` would force every byte-in/byte-out call site (the Store,
 *     a Vitest harness) to depend on dialog availability.
 *   - The Settings flow is renderer-orchestrated: dialog → file bytes →
 *     `parseSnapshot` → `Snapshot` → `replaceSnapshot` (Store action) →
 *     `saveSnapshot` (Store via adapter). The two-adapter split keeps
 *     persistence and user-file-IO cleanly separable, mirroring ADR 0003's
 *     "the Store calls only the StoreAdapter interface".
 *
 * Implementations:
 *   - {@link apps/electron/main/settingsHandlers.ts} — desktop, Electron
 *     `dialog.showSaveDialog` / `showOpenDialog` + Node `fs`. Exposed on the
 *     renderer's window through the preload proxy `window.cookietodoSettingsAdapter()`.
 *   - apps/android/CapacitorSettingsAdapter (slice 10) — Capacitor Filesystem
 *     + `@capacitor/share` for the user-facing Save dialog.
 *
 * PUBLIC SURFACE: `@cookietodo/renderer/settings`
 * (see `../../package.json` `exports` map entry). Read by the Settings UI
 * overlay (`src/ui/SettingsView.tsx`).
 */
import type { Snapshot } from "../domain/types";

/**
 * User-facing Import/Export affordance backed by native OS dialogs.
 *
 * Both methods are async: the desktop backend goes through `dialog.show*`
 * (main-process IPC round-trip from the renderer preload proxy); the future
 * Android backend goes through Capacitor's promise-based Filesystem / Share
 * plugins.
 */
export interface SettingsAdapter {
  /**
   * Open a native Save dialog and persist the `snapshot` as strict-JSON
   * `.todo.json` bytes at the user-chosen path (ADR 0001 Export side,
   * ADR 0003 dialog path on desktop).
   *
   * @param snapshot The Snapshot to export — canonicalized via
   *   {@link ../snapshot/serialize.ts#serializeSnapshot} on the implementing
   *   side. The caller passes the in-memory Store's snapshot verbatim.
   * @returns The absolute path the file was written to (or `null` when the
   *   user dismissed the Save dialog without choosing a path — ADR 0008:
   *   dismissal is NOT an error, the UI surfaces nothing).
   * @throws {Error} on filesystem write / atomic-rename failure (the desktop
   *   impl re-uses the write-tmp + fsync + rename path from
   *   {@link apps/electron/main/ElectronStoreAdapter.saveSnapshot}).
   */
  exportSnapshot(snapshot: Snapshot): Promise<string | null>;
  /**
   * Open a native Open dialog, read the user-picked file, parse it through
   * `parseSnapshot` (JSONC-tolerant per ADR 0001 Import side), validate
   * against `SnapshotSchema`, and return the resulting {@link Snapshot}.
   *
   * The renderer-side flow POST this Snapshot into the in-memory Store via
   * the Store's `replaceSnapshot` action (which persists atomically via
   * `StoreAdapter.saveSnapshot()` per ADR 0001 + ADR 0003). The Import
   * dialog does NOT itself persist — that is the Store's job (single
   * authoritative write per Import; matches ADR 0003 "writes scale O(n)
   * with todo count" budget and keeps persistence on the existing adapter
   * contract).
   *
   * @returns The parsed `Snapshot`. `null` when the user dismissed the Open
   *   dialog without choosing a file (ADR 0008 — not an error).
   * @throws {SnapshotParseError} on JSONC syntax failure (see `parse.ts`).
   * @throws {import("zod").ZodError} on Snapshot schema validation failure.
   * @throws {Error} on filesystem read failure (rejected + UI surfaces per
   *   ADR 0008 failure-mode UX).
   */
  importSnapshot(): Promise<Snapshot | null>;
}

/**
 * Window-global injected by the Electron preload (Wave-2) — supplies the
 * shell-appropriate {@link SettingsAdapter} (renderer IPC proxy to the
 * main-process `dialog`-backed impl). `undefined` in Vitest / headless Vite
 * preview (no preload present): the Settings UI must degrade gracefully —
 * Export/Import buttons render DISABLED with a tooltip-style reason, OR the
 * Settings overlay is not openable at all (slice 4 chose the disabled-button
 * affordance so the user can discover Settings exist; matches the slice-2
 * `electronRendererStub` convention of an absent-shell being a soft-fail).
 */
declare global {
  interface Window {
    cookietodoSettingsAdapter?: () => SettingsAdapter;
  }
}
