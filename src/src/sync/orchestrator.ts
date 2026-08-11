/**
 * Slice 7 — Sync orchestrator (manual transport per ADR 0005).
 *
 * The orchestrator choreographs a single Sync pass:
 *   1. Load the local Snapshot from the StoreAdapter.
 *   2. Load the last-known common ancestor from `snapshot.history.jsonl`
 *      (the previous merged result).
 *   3. Merge local + remote + ancestor via {@link merge}.
 *   4. Persist the merged result atomically via `StoreAdapter.saveSnapshot`
 *      (write-tmp + fsync + rename per ADR 0003).
 *   5. Append a merge entry to `snapshot.history.jsonl`.
 *
 * Returns a {@link SyncResult} describing the outcome so the UI can:
 *   - show a toast when `conflictCount > 0` (ADR 0008)
 *   - surface history
 *   - drive "Revert last merge"
 *
 * WebDAV transport is out of scope for slice 7 — manual file exchange only.
 */

import type { Snapshot } from "../domain/types";
import { SnapshotSchema } from "../domain/types";
import type { StoreAdapter } from "../persistence/StoreAdapter";
import { appendHistory, loadRevertAncestor } from "./history";
import { type MergeResult, merge } from "./merge";

export interface SyncResult {
  ok: boolean;
  merged: Snapshot;
  /** The MergeResult from the merge engine (for the UI toast + history). */
  mergeResult: MergeResult;
  /** Number of field-level conflicts resolved. */
  conflictCount: number;
  /** True if the merge had any conflicts (triggers the toast per ADR 0008). */
  hadConflicts: boolean;
  error?: string;
}

/**
 * Run a single manual Sync pass.
 *
 * @param adapter The StoreAdapter (local persistence).
 * @param remote The remote Snapshot (imported from another device / built locally).
 * @returns A {@link SyncResult} describing the outcome.
 */
export async function runSync(adapter: StoreAdapter, remote: Snapshot): Promise<SyncResult> {
  try {
    // Load local snapshot
    const local = await adapter.loadSnapshot();

    // Load the last-known common ancestor (the previous merged result)
    const revert = await loadRevertAncestor(adapter);
    const ancestor = revert?.snapshot ?? null;

    // Merge
    const mergeResult = await merge(local, remote, ancestor);

    // Persist the merged result atomically
    await adapter.saveSnapshot(mergeResult.merged);

    // Append a merge entry to the history file
    await appendHistory(adapter, local, remote, ancestor, mergeResult.merged, mergeResult.report);

    return {
      ok: true,
      merged: mergeResult.merged,
      mergeResult,
      conflictCount: mergeResult.report.conflictCount,
      hadConflicts: mergeResult.report.conflictCount > 0,
    };
  } catch (err) {
    return {
      ok: false,
      merged: SnapshotSchema.parse({}),
      mergeResult: {
        merged: SnapshotSchema.parse({}),
        report: {
          localHash: "",
          remoteHash: "",
          ancestorHash: null,
          conflictCount: 0,
          totalChanges: 0,
          perEntityDiffs: {},
        },
      },
      conflictCount: 0,
      hadConflicts: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Revert the last merge: load the previous common ancestor Snapshot from
 * `snapshot.history.jsonl`, replace the active Snapshot, and persist it.
 *
 * @param adapter The StoreAdapter.
 * @returns `true` if the revert succeeded, `false` if there was no history
 *   to revert to.
 */
export async function revertLastMerge(adapter: StoreAdapter): Promise<boolean> {
  const revert = await loadRevertAncestor(adapter);
  if (revert === null) {
    return false;
  }
  await adapter.saveSnapshot(revert.snapshot);
  return true;
}
