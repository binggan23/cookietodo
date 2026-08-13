/**
 * Slice 8 — renderer-side WebDAV transport proxy (ADR 0005).
 *
 * The real Node-HTTP driver lives in the Electron main process
 * (`apps/electron/main/webdavTransport.ts`) behind `cookietodo:webdav:*`
 * IPC channels; this module is the thin renderer side implementing the
 * {@link SyncTransport} seam. It resolves the window-global injected by the
 * preload (`window.cookietodoWebDAVTransport()`, mirroring
 * `cookietodoStoreAdapter` / `cookietodoDeviceAdapter`) and converts
 * main-process errors into classified {@link SyncTransportError}s so the
 * orchestrator's failure-kind mapping never sees raw URLs.
 *
 * When the preload is absent (Vitest / headless Vite preview) it degrades to
 * throwing `unknown` — exactly like the other adapter stubs adapting soft.
 */
import type { SyncFailureKind, SyncTransport } from "../transport";
import { SyncTransportError } from "./memoryStub";

// Allow typechecking in environments without DOM lib (e.g. Electron main
// process tsconfig with `lib: ["ES2022"]` — the preload compiles there and
// imports this module's type).
declare var window: {
  cookietodoWebDAVTransport?: () => RawWebDAVTransport;
} & typeof globalThis;

/**
 * The window-global the preload exposes. Kept local to this module so the
 * transport code is the only consumer (matches the adapter convention of
 * declaring the global next to its interface).
 */
declare global {
  interface Window {
    cookietodoWebDAVTransport?: () => RawWebDAVTransport;
  }
}

/**
 * The shape the main-process driver exposes over IPC (mirrors
 * `apps/electron/main/webdavTransport.ts`).
 */
export interface RawWebDAVTransport {
  acquireLock(url: string): Promise<string>;
  pull(): Promise<string | null>;
  putAndUnlock(lockId: string, raw: string): Promise<void>;
  releaseLock(lockId: string): Promise<void>;
}

/** The URL the transport is bound to (set when credentials are saved). */
let boundUrl: string | null = null;

/** Bind the transport to a WebDAV endpoint URL (called on settings save). */
export function bindWebDAVTransport(url: string): void {
  boundUrl = url;
}

function resolveTransport(): RawWebDAVTransport | null {
  if (typeof window === "undefined") {
    return null;
  }
  return window.cookietodoWebDAVTransport?.() ?? null;
}

/** Parse `[webdav:kind]` prefix from main-process classified errors. */
const WEBDAV_ERROR_RE = /^\[webdav:(\w+)\]\s*/;

function parseWebDAVKind(err: unknown): SyncFailureKind {
  const msg = err instanceof Error ? err.message : String(err);
  const match = msg.match(WEBDAV_ERROR_RE);
  if (match) {
    const kind = match[1] as SyncFailureKind;
    const validKinds: SyncFailureKind[] = [
      "unauthorized",
      "server",
      "client",
      "network",
      "locked",
      "lock-unsupported",
      "unknown",
    ];
    return validKinds.includes(kind) ? kind : "unknown";
  }
  return "unknown";
}

export function createWebDAVSyncTransport(): SyncTransport {
  const raw = resolveTransport();
  return {
    async acquireLock(): Promise<string> {
      const t = raw;
      if (t === null || boundUrl === null) {
        throw new SyncTransportError("unknown", "WebDAV transport unavailable");
      }
      try {
        return await t.acquireLock(boundUrl);
      } catch (err) {
        throw new SyncTransportError(parseWebDAVKind(err), String(err));
      }
    },
    async pull(): Promise<string | null> {
      const t = raw;
      if (t === null) {
        throw new SyncTransportError("unknown", "WebDAV transport unavailable");
      }
      try {
        return await t.pull();
      } catch (err) {
        throw new SyncTransportError(parseWebDAVKind(err), String(err));
      }
    },
    async put(lockId: string, rawContent: string): Promise<void> {
      const t = raw;
      if (t === null) {
        throw new SyncTransportError("unknown", "WebDAV transport unavailable");
      }
      try {
        await t.putAndUnlock(lockId, rawContent);
      } catch (err) {
        throw new SyncTransportError(parseWebDAVKind(err), String(err));
      }
    },
    async releaseLock(lockId: string): Promise<void> {
      const t = raw;
      if (t === null) {
        return;
      }
      try {
        await t.releaseLock(lockId);
      } catch {
        // Best-effort (ADR 0008: lock expiry is the real backstop).
      }
    },
  };
}
