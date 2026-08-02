/**
 * In-memory {@link StoreAdapter} stub — the renderer / Vitest headless
 * fallback when no shell-injected adapter is present on
 * `window.cookietodoStoreAdapter` (mirrors the slice-2 `electronRendererStub`
 * pattern for {@link DeviceAdapter}).
 *
 * Slice 3 implements only `loadSnapshot` / `saveSnapshot`; `importSnapshot` /
 * `exportSnapshot` throw `not-implemented` (Import/Export UI lands later —
 * the typed methods remain on the {@link StoreAdapter} surface for forward
 * compatibility per ADR 0003).
 *
 * State is a single closure variable — no JSON file, no IPC, no fs. The
 * in-snapshot shape is still validated through {@link SnapshotSchema} on
 * `loadSnapshot` so a corrupt externally-set snapshot is caught here too.
 */
import { type Snapshot, SnapshotSchema } from "../domain/types";
import type { StoreAdapter } from "./StoreAdapter";

const EMPTY_SNAPSHOT: Snapshot = SnapshotSchema.parse({});

export class MemoryStoreAdapter implements StoreAdapter {
  private state: Snapshot = EMPTY_SNAPSHOT;

  async loadSnapshot(): Promise<Snapshot> {
    // Re-validate on every read so a corrupt externally-set `state` is
    // caught here, not by the Store mid-mutation. The `parse` of an
    // already-typed value is cheap and pure.
    return SnapshotSchema.parse(this.state);
  }

  async saveSnapshot(snapshot: Snapshot): Promise<void> {
    this.state = SnapshotSchema.parse(snapshot);
  }

  async importSnapshot(_file: File): Promise<Snapshot> {
    throw new Error("MemoryStoreAdapter.importSnapshot: not-implemented this slice");
  }

  async exportSnapshot(): Promise<File> {
    throw new Error("MemoryStoreAdapter.exportSnapshot: not-implemented this slice");
  }
}
