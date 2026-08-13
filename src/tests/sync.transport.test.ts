/**
 * Slice 8 — SyncTransport seam tests.
 *
 * Verifies the transport contract (pull/put/acquireLock/releaseLock) against
 * the in-memory stub, the LOCK-contention and offline failure classification
 * that the orchestrator + scheduler rely on, and the opaque-lockId semantics.
 * The renderer IPC proxy itself is trivial passthrough (covered by the
 * Playwright stub-server e2e in the electron workspace).
 */
import { describe, expect, it } from "vitest";
import {
  failureKindOf,
  MemorySyncTransport,
  SyncTransportError,
} from "../src/sync/transport/memoryStub";

describe("SyncTransport: pull/put round-trip", () => {
  it("returns null on an empty remote, then round-trips a raw string after put", async () => {
    const t = new MemorySyncTransport();
    expect(await t.pull()).toBeNull();

    const lockId = await t.acquireLock();
    await t.put(lockId, '{"schemaVersion":1}');

    expect(await t.pull()).toBe('{"schemaVersion":1}');
  });

  it("exposes an opaque lockId and releases it", async () => {
    const t = new MemorySyncTransport();
    const lockId = await t.acquireLock();
    expect(lockId).toMatch(/^lock-/);
    await t.releaseLock(lockId);
    // A second lock can now be acquired (first was released).
    const lockId2 = await t.acquireLock();
    expect(lockId2).not.toBe(lockId);
  });
});

describe("SyncTransport: failure classification", () => {
  it("maps LOCK contention to kind locked", async () => {
    const t = new MemorySyncTransport();
    t.forceLocked = true;
    await expect(t.acquireLock()).rejects.toBeInstanceOf(SyncTransportError);
    try {
      await t.acquireLock();
    } catch (err) {
      expect(failureKindOf(err)).toBe("locked");
    }
  });

  it("maps network failure to kind network", async () => {
    const t = new MemorySyncTransport();
    t.forceNetwork = true;
    await expect(t.pull()).rejects.toBeInstanceOf(SyncTransportError);
    try {
      await t.pull();
    } catch (err) {
      expect(failureKindOf(err)).toBe("network");
    }
  });
});
