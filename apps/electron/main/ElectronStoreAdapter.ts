/**
 * Desktop main-process {@link StoreAdapter} backed by Node `fs` against
 * `app.getPath('userData')/snapshot.json` (ADR 0003).
 *
 * Slice 3 implements only `loadSnapshot` / `saveSnapshot`; the
 * `importSnapshot` / `exportSnapshot` methods are typed on the interface for
 * forward-compat (Import/Export UI lands in a later slice) and throw
 * `not-implemented` here, mirroring {@link MemoryStoreAdapter}.
 *
 * Write atomicity (ADR 0003 "Consequences"): `saveSnapshot` rewrites the
 * whole file every time (ADR 0003 backstops performance for v1: a personal
 * todo Snapshot is < 100 KB and `readFile`+`JSON.parse` measures < 5 ms).
 * The rewrite is atomic:
 *   1. open `snapshot.json.tmp` (same dir → same fs → rename is atomic),
 *   2. write the strict-JSON bytes (`JSON.stringify(snapshot, null, 2)`,
 *      stable key order per ADR 0001 / `z.strictObject`-derived SnapshotSchema),
 *   3. `fsync` (durability — survive a crash between write and rename),
 *   4. `close` (release the fd; do not leak it on error),
 *   5. `rename(tmp, snapshot)` (POSIX `rename(2)` atomic on same fs; Node's
 *      `fs.promises.rename` transparently maps Win32 → `MoveFileEx` with
 *      `MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH` per ADR 0003).
 *
 * Read path (ADR 0003 first-launch): missing/unreadable/malformed
 * `snapshot.json` returns the empty Snapshot — `SnapshotSchema.parse({})`
 * — so the app boots into a clean first-launch state. Malformed JSON or a
 * Zod validation failure is logged via `console.warn` (the user should know
 * the persisted file is corrupt) but the app still boots. ENOENT is silent
 * (first launch with no prior data — the expected common case).
 *
 * This file is the `adapter` argument that Wave 3's
 * `registerStoreAdapterIpc` (mirroring slice-2's
 * {@link registerDeviceAdapterIpc}) will receive from
 * {@link apps/electron/main/index.ts}.
 */
import { type FileHandle, open, readFile, rename, unlink } from "node:fs/promises";
import type { StoreAdapter } from "@cookietodo/renderer/persistence";
import { app } from "electron";
import { type Snapshot, SnapshotSchema } from "./snapshotSchema.js";

const SNAPSHOT_FILENAME = "snapshot.json";
const TMP_FILENAME = "snapshot.json.tmp";

function snapshotPath(): string {
  // `app.getPath('userData')` is the Electron-per-user config dir.
  // Per ADR 0003 the Snapshot is a single strict-JSON file in that dir.
  const dir = app.getPath("userData");
  return `${dir}/${SNAPSHOT_FILENAME}`;
}

function tmpPath(): string {
  const dir = app.getPath("userData");
  return `${dir}/${TMP_FILENAME}`;
}

async function emptySnapshot(): Promise<Snapshot> {
  // Re-validated through SnapshotSchema — parse-don't-validate (ADR 0003).
  return SnapshotSchema.parse({});
}

/**
 * Desktop main-process {@link StoreAdapter}.
 *
 * Constructorless: the paths are derived from `app.getPath('userData')` on
 * each call (the userData dir is fixed for the lifetime of the Electron app
 * process, so reading it lazily is correct and avoids racing `app.whenReady`).
 */
export class ElectronStoreAdapter implements StoreAdapter {
  async loadSnapshot(): Promise<Snapshot> {
    try {
      const raw = await readFile(snapshotPath(), "utf8");
      const parsedRaw: unknown = JSON.parse(raw);
      return SnapshotSchema.parse(parsedRaw);
    } catch (err) {
      // Distinguish "first launch — no file yet" (ENOENT, silent) from
      // "the persisted file is corrupt" (JSON.parse / Zod failure — log so
      // the user knows their data is gone; ADR 0003 mandates first-launch
      // semantics either way).
      if (!isEnoent(err)) {
        console.warn(
          "[ElectronStoreAdapter] snapshot.json missing/corrupt — booting empty first-launch snapshot:",
          err,
        );
      }
      return emptySnapshot();
    }
  }

  async saveSnapshot(snapshot: Snapshot): Promise<void> {
    const json = JSON.stringify(snapshot, null, 2);
    const target = snapshotPath();
    const tmp = tmpPath();
    let fh: FileHandle | null = null;
    try {
      fh = await open(tmp, "w");
      await fh.writeFile(json);
      await fh.sync();
      await fh.close();
      fh = null;
      // POSIX rename(2) atomic on same fs; Win32 transparent via Node.
      await rename(tmp, target);
    } catch (err) {
      if (fh !== null) {
        try {
          await fh.close();
        } catch {
          // best-effort close on the error path; the fd may already be gone
        }
      }
      // Best-effort cleanup of the tmp file (ignore ENOENT — maybe rename
      // succeeded then a later step threw, maybe open failed and tmp does
      // not exist). Surface the underlying error to the caller (Wave 3
      // renderer IPC handler) — no silent failure per ADR 0008.
      try {
        await unlink(tmp);
      } catch (cleanupErr) {
        if (!isEnoent(cleanupErr)) {
          console.warn("[ElectronStoreAdapter] failed to remove tmp file after error:", cleanupErr);
        }
      }
      throw err;
    }
  }

  async importSnapshot(_file: File): Promise<Snapshot> {
    // Out of scope for slice 3 (Import/Export UI lands in a later slice).
    // The typed method stays on the StoreAdapter surface for forward-compat
    // — implementations throw `not-implemented` per ADR 0003.
    throw new Error("ElectronStoreAdapter.importSnapshot: not-implemented this slice");
  }

  async exportSnapshot(): Promise<File> {
    throw new Error("ElectronStoreAdapter.exportSnapshot: not-implemented this slice");
  }

  async readHistoryFile(filename: string): Promise<string | null> {
    try {
      const dir = app.getPath("userData");
      return await readFile(`${dir}/${filename}`, "utf8");
    } catch (err) {
      if (isEnoent(err)) {
        return null;
      }
      throw err;
    }
  }

  async appendHistoryFile(filename: string, line: string): Promise<void> {
    const dir = app.getPath("userData");
    const { appendFile } = await import("node:fs/promises");
    await appendFile(`${dir}/${filename}`, line, "utf8");
  }
}

/**
 * Treat `ENOENT` as the benign first-launch case (silent); everything else
 * (EACCES, JSON parse error, Zod validation error) is logged in the caller.
 */
function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    // NodeFS errors carry `code: "ENOENT"`.
    (err as { code?: unknown }).code === "ENOENT"
  );
}
