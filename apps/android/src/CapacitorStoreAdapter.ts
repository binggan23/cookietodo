/**
 * CapacitorStoreAdapter — StoreAdapter backed by @capacitor/filesystem
 * (ADR 0003). Used in the Android / Capacitor shell; mirrors the desktop
 * ElectronStoreAdapter pattern.
 *
 * Persistence directory: `Documents/cookietodo/` (app-private data).
 * Atomic write: serialize to temp file, write to target, remove temp.
 * Capacitor's Filesystem plugin does not expose rename(2), so atomicity
 * is best-effort: the temp write is a safe-guard against partial writes.
 *
 * PUBLIC SURFACE: injected into `window.cookietodoStoreAdapter` by the
 * Android app shell (Capacitor WebView bootstrap).
 */
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import type { Snapshot } from "@cookietodo/renderer/domain";
import type { StoreAdapter } from "@cookietodo/renderer/persistence";

const DATA_DIR = "cookietodo";
const SNAPSHOT_FILE = "snapshot.json";
const TMP_FILE = "snapshot.json.tmp";

function snapshotPath(): string {
  return `${DATA_DIR}/${SNAPSHOT_FILE}`;
}

function tmpPath(): string {
  return `${DATA_DIR}/${TMP_FILE}`;
}

async function ensureDataDir(): Promise<void> {
  try {
    await Filesystem.mkdir({
      path: DATA_DIR,
      directory: Directory.Documents,
      recursive: true,
    });
  } catch {
    // Directory already exists — ignore
  }
}

export class CapacitorStoreAdapter implements StoreAdapter {
  async loadSnapshot(): Promise<Snapshot> {
    try {
      const result = await Filesystem.readFile({
        path: snapshotPath(),
        directory: Directory.Documents,
        encoding: Encoding.UTF8,
      });
      const raw: unknown = JSON.parse(result.data as string);
      // Import SnapshotSchema dynamically to avoid circular deps at module level
      const { SnapshotSchema } = await import("@cookietodo/renderer/domain");
      return SnapshotSchema.parse(raw) as Snapshot;
    } catch (err) {
      const isEnoent =
        typeof err === "object" &&
        err !== null &&
        "message" in err &&
        typeof (err as { message: unknown }).message === "string" &&
        ((err as { message: string }).message.includes("File does not exist") ||
          (err as { message: string }).message.includes("ENOENT"));

      if (!isEnoent) {
        console.warn(
          "[CapacitorStoreAdapter] snapshot.json missing/corrupt — booting empty:",
          err,
        );
      }
      const { SnapshotSchema } = await import("@cookietodo/renderer/domain");
      return SnapshotSchema.parse({}) as Snapshot;
    }
  }

  async saveSnapshot(snapshot: Snapshot): Promise<void> {
    await ensureDataDir();
    const json = JSON.stringify(snapshot, null, 2);

    // Atomic write: write to temp first, then overwrite target
    await Filesystem.writeFile({
      path: tmpPath(),
      data: json,
      directory: Directory.Documents,
      encoding: Encoding.UTF8,
    });

    await Filesystem.writeFile({
      path: snapshotPath(),
      data: json,
      directory: Directory.Documents,
      encoding: Encoding.UTF8,
    });

    // Clean up temp file (best-effort)
    try {
      await Filesystem.deleteFile({
        path: tmpPath(),
        directory: Directory.Documents,
      });
    } catch {
      // Ignore cleanup failure
    }
  }

  async importSnapshot(_file: File): Promise<Snapshot> {
    throw new Error("CapacitorStoreAdapter.importSnapshot: not-implemented this slice");
  }

  async exportSnapshot(): Promise<File> {
    throw new Error("CapacitorStoreAdapter.exportSnapshot: not-implemented this slice");
  }

  async readHistoryFile(filename: string): Promise<string | null> {
    try {
      const result = await Filesystem.readFile({
        path: `${DATA_DIR}/${filename}`,
        directory: Directory.Documents,
        encoding: Encoding.UTF8,
      });
      return result.data as string;
    } catch {
      return null;
    }
  }

  async appendHistoryFile(filename: string, line: string): Promise<void> {
    await ensureDataDir();
    await Filesystem.appendFile({
      path: `${DATA_DIR}/${filename}`,
      data: line,
      directory: Directory.Documents,
      encoding: Encoding.UTF8,
    });
  }
}