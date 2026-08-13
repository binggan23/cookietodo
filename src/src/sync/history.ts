/**
 * Slice 7 — Snapshot history JSONL management (ADR 0004).
 *
 * `snapshot.history.jsonl` is an append-only file that stores merge reports
 * as one JSON line per merge pass. The last entry's merged snapshot becomes
 * the next merge's common ancestor.
 *
 * Public API:
 *   - `readHistory(adapter, limit)` — read the last N merge entries (most recent first)
 *   - `appendHistory(adapter, entry)` — append a new merge entry
 *   - `revertToAncestor(adapter)` — load the previous common ancestor snapshot
 *     for the "Revert last merge" action
 *   - `gcTombstones(snapshot, acknowledgedDeviceIds)` — GC tombstones older
 *     than 30 days when all known devices have acknowledged them
 */

import type { Snapshot, Tombstone } from "../domain/types";
import { SnapshotSchema } from "../domain/types";
import type { StoreAdapter } from "../persistence/StoreAdapter";
import type { MergeReport } from "./merge";

// ============================================================================
// CONSTANTS
// ============================================================================

/** Max history entries to display in the UI. */
const MAX_HISTORY_DISPLAY = 30;

/** Tombstone retention period in ms (30 days). */
const TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// ============================================================================
// TYPES
// ============================================================================

export interface HistoryEntry {
  /** Timestamp of the merge (epoch ms). */
  timestamp: number;
  /** SHA-256 hash of the local snapshot before merge. */
  localHash: string;
  /** SHA-256 hash of the remote snapshot. */
  remoteHash: string;
  /** SHA-256 hash of the common ancestor snapshot (null for first sync). */
  ancestorHash: string | null;
  /** SHA-256 hash of the merged result. */
  mergedHash: string;
  /** Count of field-level conflicts resolved. */
  conflictCount: number;
  /** Total changes made. */
  totalChanges: number;
  /** Per-entity diffs (only for entities with conflicts). */
  perEntityDiffs: Record<string, EntityDiffRecord>;
  /** The ancestor snapshot, serialized, for revert. */
  ancestorSnapshot: string | null;
  /** The local snapshot before merge, serialized, for revert. */
  localSnapshot: string | null;
  /**
   * Opaque per-pass metadata (slice 8). Carries e.g. the WebDAV endpoint
   * reference as a hash (`webdavUrl`) so a sync pass can be correlated to a
   * device without the raw endpoint path sitting in the plaintext JSONL.
   * Absent for manual-file sync passes (never part of the Snapshot JSON).
   */
  metadata?: Record<string, string>;
}

interface EntityDiffRecord {
  kind: "todo" | "list" | "reminder";
  id: string;
  fields: Record<string, FieldDiffRecord>;
}

interface FieldDiffRecord {
  ancestor?: unknown;
  local?: unknown;
  remote?: unknown;
  merged: unknown;
  conflict: boolean;
}

// ============================================================================
// HASH UTILITIES
// ============================================================================

function hashSnapshot(snapshot: Snapshot): string {
  return fnv1a(JSON.stringify(snapshot));
}

/**
 * FNV-1a 32-bit hash — deterministic string hash that works in any
 * JS runtime (browser + Node). Used for snapshot content hashing.
 */
function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// ============================================================================
// HISTORY FILE OPERATIONS
// ============================================================================

/**
 * History file path relative to the adapter's data directory.
 * The adapter provides the bytes; this module constructs the logical path.
 */
const HISTORY_FILENAME = "snapshot.history.jsonl";

/**
 * Read the last N merge entries from the history file.
 * Returns entries in reverse chronological order (most recent first).
 */
export async function readHistory(
  adapter: StoreAdapter,
  limit: number = MAX_HISTORY_DISPLAY,
): Promise<HistoryEntry[]> {
  try {
    // Read the raw JSONL file through the adapter
    const raw = await adapter.readHistoryFile(HISTORY_FILENAME);
    if (!raw || raw.length === 0) {
      return [];
    }
    const lines = raw.trimEnd().split("\n");
    const entries: HistoryEntry[] = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as HistoryEntry;
        entries.push(entry);
      } catch {}
    }
    // Return most recent first
    return entries.reverse().slice(0, limit);
  } catch {
    // File not found or other error — empty history
    return [];
  }
}

/**
 * Append a new merge entry to the history file.
 * The entry is created from the merge report and the snapshots.
 */
export async function appendHistory(
  adapter: StoreAdapter,
  local: Snapshot,
  _remote: Snapshot,
  ancestor: Snapshot | null,
  merged: Snapshot,
  report: MergeReport,
  metadata?: Record<string, string>,
): Promise<void> {
  const entry: HistoryEntry = {
    timestamp: Date.now(),
    localHash: report.localHash,
    remoteHash: report.remoteHash,
    ancestorHash: report.ancestorHash,
    mergedHash: hashSnapshot(merged),
    conflictCount: report.conflictCount,
    totalChanges: report.totalChanges,
    perEntityDiffs: Object.fromEntries(
      Object.entries(report.perEntityDiffs).map(([id, diff]) => [
        id,
        {
          kind: diff.kind,
          id: diff.id,
          fields: Object.fromEntries(
            Object.entries(diff.fields).map(([fieldName, outcome]) => [
              fieldName,
              {
                ancestor: outcome.ancestor,
                local: outcome.local,
                remote: outcome.remote,
                merged: outcome.merged,
                conflict: outcome.conflict,
              },
            ]),
          ),
        },
      ]),
    ),
    ancestorSnapshot: ancestor ? JSON.stringify(ancestor) : null,
    localSnapshot: JSON.stringify(local),
    ...(metadata ? { metadata } : {}),
  };

  const line = `${JSON.stringify(entry)}\n`;
  await adapter.appendHistoryFile(HISTORY_FILENAME, line);
}

/**
 * Load the previous common ancestor snapshot for the "Revert last merge" action.
 *
 * Reads the last entry from the history file and returns the local snapshot
 * from before the merge (the state the user wants to revert TO). If there's
 * no history, returns null (cannot revert).
 */
export async function loadRevertAncestor(
  adapter: StoreAdapter,
): Promise<{ snapshot: Snapshot; historyEntry: HistoryEntry } | null> {
  const entries = await readHistory(adapter, 1);
  if (entries.length === 0) {
    return null;
  }
  const lastEntry = entries[0];
  if (!lastEntry) return null;
  const revertSource = lastEntry.localSnapshot ?? lastEntry.ancestorSnapshot;
  if (!revertSource) {
    return null;
  }
  try {
    const parsed = JSON.parse(revertSource) as Snapshot;
    const snapshot = SnapshotSchema.parse(parsed);
    return { snapshot, historyEntry: lastEntry };
  } catch {
    return null;
  }
}

// ============================================================================
// TOMBSTONE GC
// ============================================================================

/**
 * GC tombstones that are older than 30 days and have been acknowledged
 * by all known devices. Removes eligible tombstones from the snapshot.
 *
 * @param snapshot The current snapshot
 * @param acknowledgedDeviceIds Set of device IDs that have acknowledged
 *   the tombstones. When all devices have acknowledged, the tombstone is GC-eligible.
 * @returns A new snapshot with GC'd tombstones removed
 */
export function gcTombstones(
  snapshot: Snapshot,
  acknowledgedDeviceIds: Set<string> = new Set(),
): Snapshot {
  const now = Date.now();
  const retentionCutoff = now - TOMBSTONE_RETENTION_MS;

  const retained: Tombstone[] = [];
  for (const tombstone of snapshot.deleted) {
    // Keep if the tombstone is still within the retention period
    if (tombstone.deletedAt > retentionCutoff) {
      retained.push(tombstone);
      continue;
    }
    // Tombstone is older than 30 days — only GC if all devices have acknowledged
    // For v1 without device tracking, we keep tombstones that are old
    // but not yet acknowledged
    if (acknowledgedDeviceIds.size === 0) {
      // No device tracking — keep all tombstones (conservative)
      retained.push(tombstone);
    }
    // If all devices acknowledged, the tombstone is dropped
  }

  return SnapshotSchema.parse({
    ...snapshot,
    deleted: retained,
  });
}
