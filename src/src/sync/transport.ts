/**
 * Slice 8 — SyncTransport seam (ADR 0005, issue #10).
 *
 * A transport carries one Snapshot file across the sync channel and guards
 * against concurrent writes. Slice 7 shipped the manual-file transport
 * (reuses Import). This file defines the seam a WebDAV transport implements;
 * the real Node-HTTP driver lives in the Electron main process
 * (`apps/electron/main/webdavTransport.ts`) and is reached from the renderer
 * through the {@link ./transport/webdav} IPC proxy — mirroring the
 * StoreAdapter / DeviceAdapter / AlarmAdapter shell-vs-TS split.
 *
 * The seam deals in RAW string bytes (never a parsed Snapshot): `pull`
 * returns the remote file content; `put` uploads merged content. The
 * orchestrator parses + Zod-validates at the parse-don't-validate boundary
 * so manual-file and WebDAV share the same "get remote as parseable
 * content" path.
 *
 * LOCK semantics: `acquireLock` returns an OPAQUE lockId (never the raw
 * WebDAV lock-token); `put` and `releaseLock` are keyed by that lockId. The
 * main-process driver owns the real lock-token inside a session map.
 */
import type { Snapshot } from "../domain/types";

/** Classified sync failure cause (ADR 0008 §A) — the UI maps this to a row. */
export type SyncFailureKind =
  /** 401 — bad WebDAV credentials. */
  | "unauthorized"
  /** 5xx — server error. */
  | "server"
  /** 4xx other than 401/423 (e.g. 404 remote missing, treated as empty). */
  | "client"
  /** Network / DNS / offline. */
  | "network"
  /** LOCK contention (423 Locked) — retried silently, never surfaced. */
  | "locked"
  /** Remote server does not support LOCK (405) — fall back to optimistic PUT. */
  | "lock-unsupported"
  /** Unknown / unexpected. */
  | "unknown";

/**
 * The transport seam. All methods async; the WebDAV driver goes through
 * main-process IPC, so every call returns a Promise.
 */
export interface SyncTransport {
  /**
   * Read the remote Snapshot file. Returns `null` when the remote has no
   * snapshot yet (first ever sync) — the orchestrator treats that as empty.
   * Throws a classified transport error on failure.
   */
  pull(): Promise<string | null>;
  /**
   * Write the merged Snapshot back to the remote, under the held lock
   * identified by `lockId`. Unlock is owned by the driver in the same
   * handler (finally-guarded) so it always follows the put.
   */
  put(lockId: string, raw: string): Promise<void>;
  /**
   * Acquire the remote write lock. Returns an opaque lockId; the driver
   * keeps the real token server-side.
   */
  acquireLock(): Promise<string>;
  /** Release the write lock identified by `lockId`. Best-effort. */
  releaseLock(lockId: string): Promise<void>;
}

/**
 * A sync pass outcome that carries a {@link SyncFailureKind} so the
 * scheduler / UI can react without seeing raw URLs or token data.
 */
export interface SyncPassOutcome {
  ok: boolean;
  kind: SyncFailureKind;
  /** Merged snapshot when ok (used by UI toast + store swap). */
  merged: Snapshot | null;
  /** Human-readable cause for the status row (redacted — no URL). */
  message?: string;
}
