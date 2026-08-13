import type { WebDAVCredentials } from "@cookietodo/renderer/device";
import { createClient, type WebDAVClient, type WebDAVClientError } from "webdav";

// ============================================================================
// CONSTANTS
// ============================================================================

/** Remote snapshot filename on the WebDAV server. */
const REMOTE_SNAPSHOT_PATH = "snapshot.json";

/** LOCK timeout — short enough that a crash-leak expires fast. */
const LOCK_TIMEOUT = "Second-60";

// ============================================================================
// TYPES
// ============================================================================

export type SyncFailureKind =
  | "unauthorized"
  | "server"
  | "client"
  | "network"
  | "locked"
  | "lock-unsupported"
  | "unknown";

export interface WebDAVLockSession {
  client: WebDAVClient;
  path: string;
  token: string;
  url: string;
  // For later `If` header on PUT.
}

export interface WebDAVTransport {
  acquireLock(url: string): Promise<string>;
  pull(): Promise<string | null>;
  putAndUnlock(lockId: string, raw: string): Promise<void>;
  releaseLock(lockId: string): Promise<void>;
  classifyError(err: unknown): { kind: SyncFailureKind; message: string };
}

// ============================================================================
// ERROR CLASSIFICATION
// ============================================================================

/** Check if an error is a `WebDAVClientError` (HTTP-level failure). */
function isWebDAVClientError(err: unknown): err is WebDAVClientError & {
  status?: number;
} {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    typeof (err as { status?: unknown }).status === "number"
  );
}

/** Check if an error is a network-level failure (node-fetch `FetchError`). */
function isNetworkError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "type" in err &&
    (err as { type: string }).type === "system"
  );
}

export function classifyError(err: unknown): { kind: SyncFailureKind; message: string } {
  if (isWebDAVClientError(err)) {
    const status = err.status ?? 0;
    if (status === 401) {
      return { kind: "unauthorized", message: "Authentication failed (401)" };
    }
    if (status === 423) {
      return { kind: "locked", message: "Resource locked (423)" };
    }
    if (status === 405) {
      return { kind: "lock-unsupported", message: "LOCK not supported (405)" };
    }
    if (status >= 500) {
      return { kind: "server", message: `Server error (${status})` };
    }
    if (status >= 400) {
      return { kind: "client", message: `Client error (${status})` };
    }
    return { kind: "unknown", message: err.message ?? String(err) };
  }

  if (isNetworkError(err)) {
    const code = (err as { code?: string }).code ?? "UNKNOWN";
    return { kind: "network", message: `Network error (${code})` };
  }

  const msg = err instanceof Error ? err.message : String(err);
  return { kind: "unknown", message: msg };
}

// ============================================================================
// URL REDACTION
// ============================================================================

/**
 * Strip credentials and trailing path from a WebDAV URL for safe logging.
 * Returns something like `[webdav] https://example.com/remote.php/dav`.
 */
function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = "";
    u.password = "";
    return `[webdav] ${u.origin}${u.pathname}`;
  } catch {
    return `[webdav] <invalid-url>`;
  }
}

// ============================================================================
// LOCK SESSION MAP
// ============================================================================

const sessions = new Map<string, WebDAVLockSession>();
let nextId = 1;

// ============================================================================
// CREATE TRANSPORT
// ============================================================================

/**
 * Create a WebDAVTransport whose `acquireLock(url)` reads credentials for the
 * given URL via `getCredentials`, builds a `webdav` client, LOCKs the remote
 * resource, and returns an opaque lockId. Subsequent operations use the session
 * map to perform GET / PUT / UNLOCK without the token ever leaving this process.
 *
 * @param getCredentials - Async resolver for WebDAV credentials by endpoint URL
 *   (typically backed by `DeviceAdapter.getWebDAVCredentials`).
 */
export function createWebDAVTransport(
  getCredentials: (url: string) => Promise<WebDAVCredentials | null>,
): WebDAVTransport {
  async function acquireLock(url: string): Promise<string> {
    const creds = await getCredentials(url);
    if (creds === null) {
      throw Object.assign(new Error(`No credentials for ${redactUrl(url)}`), {
        status: 401,
      });
    }

    const client = createClient(url, {
      username: creds.user,
      password: creds.pass,
    });

    // Test connectivity + check if remote exists (if not, lock may fail — treat
    // as empty snapshot; first sync).
    const exists = await client.exists(REMOTE_SNAPSHOT_PATH).catch(() => false);

    // Lock the remote resource (ignore 404 for first sync — no file yet).
    let token: string;
    try {
      const lockResult = await client.lock(REMOTE_SNAPSHOT_PATH, {
        timeout: LOCK_TIMEOUT,
      });
      token = lockResult.token;
    } catch (lockErr) {
      // If the resource doesn't exist yet (404 on LOCK), create it via empty PUT
      // then lock. Some WebDAV servers don't support LOCK on nonexistent resources.
      if (!exists) {
        await client.putFileContents(REMOTE_SNAPSHOT_PATH, "{}");
        const lockResult = await client.lock(REMOTE_SNAPSHOT_PATH, {
          timeout: LOCK_TIMEOUT,
        });
        token = lockResult.token;
      } else {
        throw lockErr;
      }
    }

    const lockId = `wd-${nextId++}`;
    sessions.set(lockId, { client, path: REMOTE_SNAPSHOT_PATH, token, url });
    return lockId;
  }

  async function pull(): Promise<string | null> {
    // Find the latest session to get the client. The renderer should have
    // called acquireLock first.
    // We lazily resolve the client from the most-recently-acquired lock.
    // Actually, the renderer calls acquireLock then pull — the pull doesn't
    // need a lockId per se since only one lock is active at a time for the
    // sync pass. But for safety we iterate sessions. Or better, store the
    // current lockId from the most recent acquireLock.
    // Use the last-acquired session.
    let session: WebDAVLockSession | undefined;
    for (const s of sessions.values()) {
      session = s;
    }
    if (session === undefined) {
      throw new Error("pull: no active lock session");
    }

    try {
      const content: unknown = await session.client.getFileContents(session.path, {
        format: "text",
      });
      // The webdav lib returns `string` when format:"text" is used, but the
      // type union includes BufferLike | ResponseDataDetailed. Coerce safely.
      if (typeof content === "string") {
        return content;
      }
      if (
        content !== null &&
        typeof content === "object" &&
        "data" in (content as Record<string, unknown>)
      ) {
        const data = (content as { data: unknown }).data;
        return typeof data === "string" ? data : JSON.stringify(data);
      }
      return JSON.stringify(content);
    } catch (err) {
      if (isWebDAVClientError(err) && err.status === 404) {
        return null; // No remote snapshot yet.
      }
      throw err;
    }
  }

  async function putAndUnlock(lockId: string, raw: string): Promise<void> {
    const session = sessions.get(lockId);
    if (session === undefined) {
      throw new Error(`putAndUnlock: unknown lockId`);
    }

    try {
      // PUT with the lock token as the If header so the class-2 server
      // accepts the write under the held lock.
      await session.client.putFileContents(session.path, raw, {
        headers: { If: `(<${session.token}>)` },
      });
    } finally {
      // Always attempt UNLOCK, even if PUT threw (best-effort, the LOCK
      // timeout is the real backstop — ADR 0008 §B).
      try {
        await session.client.unlock(session.path, session.token);
      } catch {
        // Silent — lock expires.
      }
      sessions.delete(lockId);
    }
  }

  async function releaseLock(lockId: string): Promise<void> {
    const session = sessions.get(lockId);
    if (session === undefined) {
      return;
    }
    try {
      await session.client.unlock(session.path, session.token);
    } catch {
      // Best-effort.
    }
    sessions.delete(lockId);
  }

  return {
    acquireLock,
    pull,
    putAndUnlock,
    releaseLock,
    classifyError,
  };
}

/**
 * Expose the session map for testing (inject a pre-created client).
 */
export function _testSetSession(lockId: string, session: WebDAVLockSession): void {
  sessions.set(lockId, session);
}

/**
 * Clear all sessions (testing / cleanup).
 */
export function _testClearSessions(): void {
  sessions.clear();
}
