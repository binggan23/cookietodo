/**
 * In-memory {@link SyncTransport} stub for Vitest — the renderer / headless
 * fallback mirror of `MemoryStoreAdapter`. Holds one remote snapshot string
 * and a live-lock, so transport-level tests (and the webdavSyncPass RED tests)
 * run without Electron or a real WebDAV server.
 */
import type { SyncTransport } from "../transport";

export class MemorySyncTransport implements SyncTransport {
  /** The current remote snapshot content (raw string) or null when empty. */
  remote: string | null = null;
  /** Simulated lock owner (set while a lock is held). */
  private owner: string | null = null;
  /** Next lockId to mint. */
  private nextLock = 1;
  /** If set, `acquireLock` fails with `locked` (simulates 423 contention). */
  forceLocked = false;
  /** If set, `pull`/`put` fail with `network` (simulates offline). */
  forceNetwork = false;

  async pull(): Promise<string | null> {
    this.checkNetwork();
    return this.remote;
  }

  async put(lockId: string, raw: string): Promise<void> {
    this.checkNetwork();
    if (this.owner !== null && this.owner !== lockId) {
      throw transportError("locked", "remote locked by another device");
    }
    this.remote = raw;
  }

  async acquireLock(): Promise<string> {
    this.checkNetwork();
    if (this.forceLocked || this.owner !== null) {
      throw transportError("locked", "423 Locked");
    }
    const lockId = `lock-${this.nextLock++}`;
    this.owner = lockId;
    return lockId;
  }

  async releaseLock(lockId: string): Promise<void> {
    if (this.owner === lockId) {
      this.owner = null;
    }
  }

  private checkNetwork(): void {
    if (this.forceNetwork) {
      throw transportError("network", "network unavailable");
    }
  }
}

export class SyncTransportError extends Error {
  readonly kind: import("../transport").SyncFailureKind;
  constructor(kind: import("../transport").SyncFailureKind, message: string) {
    super(message);
    this.name = "SyncTransportError";
    this.kind = kind;
  }
}

export function transportError(
  kind: import("../transport").SyncFailureKind,
  message: string,
): SyncTransportError {
  return new SyncTransportError(kind, message);
}

export function failureKindOf(err: unknown): import("../transport").SyncFailureKind {
  if (err instanceof SyncTransportError) {
    return err.kind;
  }
  return "unknown";
}
