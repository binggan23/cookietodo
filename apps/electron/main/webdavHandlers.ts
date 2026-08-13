/**
 * Slice 8 — WebDAV IPC bridge between sandboxed renderer preload proxy and
 * the main-process {@link createWebDAVTransport} (ADR 0005, issue #10).
 *
 * Each transport method has a matching `ipcMain.handle('cookietodo:webdav:<method>', ...)`
 * channel. The renderer-side preload forwards calls via `ipcRenderer.invoke`
 * — the canonical Electron 30 / `contextBridge` / sandboxed-renderer pattern,
 * mirroring the device / store / alarm / settings IPC conventions.
 *
 * Error classification: every handler wraps the transport call and classifies
 * failures through the transport's `classifyError` utility. The kind is
 * encoded as a parseable prefix `[webdav:${kind}]` in the error message so
 * the renderer-side proxy can reconstruct the {@link SyncFailureKind} without
 * importing Node packages. Custom properties (`kind`) are also attached for
 * Electron's structured-clone serialisation (preserved across ipcMain.handle
 * rejections).
 *
 * Connector: `apps/electron/main/index.ts` calls
 * `registerWebDAVIpc(transport)` INSIDE `app.whenReady` and BEFORE
 * `createWindow()` — following the established registration ordering.
 */
import { ipcMain } from "electron";
import type { SyncFailureKind, WebDAVTransport } from "./webdavTransport.js";
import { classifyError } from "./webdavTransport.js";

const CHANNEL_PREFIX = "cookietodo:webdav:";

function channelFor(method: "acquireLock" | "pull" | "putAndUnlock" | "releaseLock"): string {
  return `${CHANNEL_PREFIX}${method}`;
}

/**
 * Wrap a raw Error with a parseable `[webdav:kind]` message prefix and a
 * `kind` property that survives Electron IPC structured clone.
 */
function wrapError(err: unknown): never {
  const classified = classifyError(err);
  const prefix = `[webdav:${classified.kind}]`;
  const error = new Error(`${prefix} ${classified.message}`);
  (error as unknown as { kind: string }).kind = classified.kind;
  throw error;
}

/**
 * Register the 4 `ipcMain.handle` channels for the given {@link WebDAVTransport}.
 * `event` is the standard Electron invoke event; unused (the handlers neither
 * depend on sender nor return frame — same shape as other adapter IPC).
 */
export function registerWebDAVIpc(transport: WebDAVTransport): void {
  ipcMain.handle(channelFor("acquireLock"), async (_event, url: string) => {
    try {
      return await transport.acquireLock(url);
    } catch (err) {
      wrapError(err);
    }
  });
  ipcMain.handle(channelFor("pull"), async () => {
    try {
      return await transport.pull();
    } catch (err) {
      wrapError(err);
    }
  });
  ipcMain.handle(channelFor("putAndUnlock"), async (_event, lockId: string, raw: string) => {
    try {
      await transport.putAndUnlock(lockId, raw);
    } catch (err) {
      wrapError(err);
    }
  });
  ipcMain.handle(channelFor("releaseLock"), async (_event, lockId: string) => {
    try {
      await transport.releaseLock(lockId);
    } catch (err) {
      wrapError(err);
    }
  });
}

/**
 * Parse a `[webdav:kind]` message prefix back into the failure kind and the
 * original message. Exported for the renderer-side proxy to use.
 */
export function parseWebDAVError(err: unknown): {
  kind: SyncFailureKind;
  message: string;
} {
  const message = err instanceof Error ? err.message : String(err);
  const match = message.match(/^\[webdav:(\w+)\]\s*(.*)/);
  if (match) {
    return { kind: match[1] as SyncFailureKind, message: match[2] ?? "" };
  }
  return { kind: "unknown", message };
}
