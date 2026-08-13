/**
 * Slice 8 — DeviceAdapter sync-interval persistence tests.
 *
 * The sync interval (1/5/15/30/60 minutes, default 5) is a per-device
 * preference stored via the DeviceAdapter (issue #10 AC: "The interval is
 * configurable in Settings"). This suite pins the stub round-trip and the
 * reject-invalid guard so the settings UI + scheduler can rely on it.
 */
import { describe, expect, it } from "vitest";
import { electronRendererStub } from "../src/device/electronRendererStub";

// The stub is backed by localStorage, which is absent in the Node Vitest env;
// provide a minimal in-memory Storage so the stub round-trip is testable
// headless (mirrors the DOM-dependent guard inside the stub).
function withLocalStorage(): void {
  const store = new Map<string, string>();
  const storage: Storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => void store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
  });
}

describe("DeviceAdapter: sync interval", () => {
  it("defaults to null (scheduler applies the 5-minute default)", async () => {
    withLocalStorage();
    expect(await electronRendererStub.getSyncInterval()).toBeNull();
  });

  it("round-trips a valid interval (5)", async () => {
    withLocalStorage();
    await electronRendererStub.saveSyncInterval(5);
    expect(await electronRendererStub.getSyncInterval()).toBe(5);
  });

  it("rejects an out-of-set value (7) and returns null", async () => {
    withLocalStorage();
    await electronRendererStub.saveSyncInterval(7 as never);
    expect(await electronRendererStub.getSyncInterval()).toBeNull();
  });
});
