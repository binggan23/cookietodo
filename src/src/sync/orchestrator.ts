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
import type { SyncPassOutcome, SyncTransport } from "./transport";

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
  /** Opaque per-pass metadata (slice 8 e.g. webdavUrl hash). */
  historyMeta?: Record<string, string>;
}

/** Options for {@link runSync} (slice 8: metadata stamping). */
export interface SyncOptions {
  historyMeta?: Record<string, string>;
}

/**
 * Run a single manual Sync pass.
 *
 * @param adapter The StoreAdapter (local persistence).
 * @param remote The remote Snapshot (imported from another device / built locally).
 * @returns A {@link SyncResult} describing the outcome.
 */
export async function runSync(
  adapter: StoreAdapter,
  remote: Snapshot,
  opts?: SyncOptions,
): Promise<SyncResult> {
  try {
    const local = await adapter.loadSnapshot();
    const revert = await loadRevertAncestor(adapter);
    const ancestor = revert?.snapshot ?? null;
    const mergeResult = await merge(local, remote, ancestor);
    await adapter.saveSnapshot(mergeResult.merged);
    await appendHistory(
      adapter,
      local,
      remote,
      ancestor,
      mergeResult.merged,
      mergeResult.report,
      opts?.historyMeta,
    );

    return {
      ok: true,
      merged: mergeResult.merged,
      mergeResult,
      conflictCount: mergeResult.report.conflictCount,
      hadConflicts: mergeResult.report.conflictCount > 0,
      ...(opts?.historyMeta ? { historyMeta: opts.historyMeta } : {}),
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

/**
 * Run a complete WebDAV sync pass using a {@link SyncTransport}.
 *
 * Sequence:
 *   1. acquireLock
 *   2. pull remote raw content
 *   3. parse via SnapshotSchema (empty -> null / not-found -> empty snapshot)
 *   4. runSync (merge + persist local)
 *   5. putAndUnlock the merged result back to remote
 *   6. releaseLock (finally-guarded)
 *
 * Returns a {@link SyncPassOutcome} with a classified failure kind so the
 * scheduler / UI can surface the status row without seeing raw URLs.
 */
export async function webdavSyncPass(
  adapter: StoreAdapter,
  transport: SyncTransport,
  opts?: { historyMeta?: Record<string, string> },
): Promise<SyncPassOutcome> {
  let lockId: string | undefined;

  try {
    lockId = await transport.acquireLock();

    // Pull remote raw content (null = no remote snapshot yet).
    const remoteRaw = await transport.pull();
    const remote: Snapshot =
      remoteRaw !== null ? SnapshotSchema.parse(JSON.parse(remoteRaw)) : SnapshotSchema.parse({});

    // Merge + persist locally.
    const syncOpts = opts?.historyMeta ? { historyMeta: opts.historyMeta } : undefined;
    const result = await runSync(adapter, remote, syncOpts);

    if (result.ok) {
      // Write merged result back to remote under the held lock.
      const mergedRaw = JSON.stringify(result.merged);
      await transport.put(lockId, mergedRaw);
    }

    return {
      ok: result.ok,
      kind: "unknown",
      merged: result.merged,
      ...(result.error ? { message: result.error } : {}),
    };
  } catch (err) {
    const kind =
      err && typeof err === "object" && "kind" in err
        ? (err as { kind: import("./transport").SyncFailureKind }).kind
        : "unknown";
    return {
      ok: false,
      kind,
      merged: SnapshotSchema.parse({}),
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (lockId !== undefined) {
      await transport.releaseLock(lockId).catch(() => {
        // Best-effort (lock timeout is the real backstop — ADR 0008 §B).
      });
    }
  }
}
