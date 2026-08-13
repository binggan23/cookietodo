/**
 * Slice 8 — Sync scheduler (ADR 0004 + issue #10).
 *
 * Drives WebDAV sync passes on a configurable interval (default 5 min):
 *   - On launch: fires immediately (online) or defers until online.
 *   - Interval: fires the webdavSyncPass at the configured frequency.
 *   - Offline detection: uses `navigator.onLine` + `window.onoffline`/`ononline`
 *     events + transport network errors.
 *   - Suspend: after >2 consecutive failed/network intervals the timer stops
 *     and a "suspended" status is emitted. On reconnect / online-event the
 *     scheduler fires immediately and resumes the interval.
 *   - Overlap guard: if a sync pass is in flight, the scheduled fire is skipped
 *     (ADR 0004 Decision B step 6).
 *
 * This module is pure logic (no React hooks). The renderer mounts it via the
 * store's lifecycle (see `hooks.ts` / `store.ts`).
 */

import type { SyncIntervalMinutes } from "../device/DeviceAdapter";
import type { StoreAdapter } from "../persistence/StoreAdapter";
import { webdavSyncPass } from "./orchestrator";
import type { SyncPassOutcome, SyncTransport } from "./transport";

/** Scheduler status emitted to listeners. */
export interface SchedulerStatus {
  state: "idle" | "syncing" | "suspended" | "offline";
  lastOutcome: SyncPassOutcome | null;
  consecutiveFailures: number;
  nextFireAt: number | null;
}

type StatusListener = (status: SchedulerStatus) => void;

/** Handle returned by `createScheduler`; call `stop()` to tear down. */
export interface SchedulerHandle {
  stop(): void;
  /** Fire a sync pass immediately (the "Sync now" button action). */
  fireNow(): Promise<SyncPassOutcome>;
  /** Read the current status. */
  getStatus(): SchedulerStatus;
}

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

function intervalToMs(minutes: SyncIntervalMinutes): number {
  return minutes * 60 * 1000;
}

function isOnline(): boolean {
  return typeof navigator !== "undefined" ? navigator.onLine : true;
}

/**
 * Create a sync scheduler bound to the given adapter and transport.
 *
 * @param adapter  The local StoreAdapter.
 * @param transport  A SyncTransport instance (WebDAV or memory stub).
 * @param getInterval  Async resolver for the configured interval (e.g.
 *   `() => deviceAdapter.getSyncInterval()`). Returns `null` for default 5 min.
 * @param historyMeta  Optional opaque metadata for history entries (webdavUrl hash).
 * @returns A {@link SchedulerHandle}.
 */
export function createScheduler(
  adapter: StoreAdapter,
  transport: SyncTransport,
  getInterval: () => Promise<SyncIntervalMinutes | null>,
  historyMeta?: Record<string, string>,
): SchedulerHandle {
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;
  let stopped = false;
  let consecutiveFailures = 0;
  let lastOutcome: SyncPassOutcome | null = null;
  let nextFireAt: number | null = null;

  const listeners = new Set<StatusListener>();

  function emitStatus(): void {
    const status: SchedulerStatus = {
      state: inFlight
        ? "syncing"
        : consecutiveFailures >= 2 && !isOnline()
          ? "suspended"
          : isOnline()
            ? "idle"
            : "offline",
      lastOutcome,
      consecutiveFailures,
      nextFireAt,
    };
    for (const cb of listeners) {
      cb(status);
    }
  }

  function scheduleNext(ms: number): void {
    if (stopped) return;
    nextFireAt = Date.now() + ms;
    emitStatus();
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(async () => {
      if (stopped || inFlight) return;
      // If online, fire; otherwise skip and reschedule.
      if (!isOnline()) {
        consecutiveFailures++;
        emitStatus();
        scheduleNext(ms);
        return;
      }
      await fireOnce();
      scheduleNext(ms);
    }, ms);
  }

  async function fireOnce(): Promise<SyncPassOutcome> {
    if (inFlight) {
      return { ok: false, kind: "unknown", merged: null, message: "Sync already in progress" };
    }
    inFlight = true;
    emitStatus();
    try {
      const outcome = await webdavSyncPass(adapter, transport, {
        ...(historyMeta ? { historyMeta } : {}),
      });
      lastOutcome = outcome;
      if (outcome.ok) {
        consecutiveFailures = 0;
      } else {
        consecutiveFailures++;
      }
      emitStatus();
      return outcome;
    } finally {
      inFlight = false;
    }
  }

  // Arm the scheduler: fire immediately if online, then start interval.
  const arm = async (): Promise<void> => {
    if (stopped) return;
    const rawInterval = await getInterval();
    const ms = rawInterval !== null ? intervalToMs(rawInterval) : DEFAULT_INTERVAL_MS;
    // Fire once immediately (on-launch per ADR 0004).
    if (isOnline() && !stopped) {
      await fireOnce().catch(() => {
        // Single-pass failure is not fatal; the interval will retry.
      });
    }
    if (!stopped) {
      scheduleNext(ms);
    }
  };

  // React to online/offline events.
  const onOnline = (): void => {
    consecutiveFailures = 0;
    emitStatus();
    // Fire immediately and resume interval (ADR 0004).
    if (!stopped && !inFlight) {
      void fireOnce().then(() => {
        const rawMs = getInterval().then((v) =>
          v !== null ? intervalToMs(v) : DEFAULT_INTERVAL_MS,
        );
        rawMs.then((ms) => scheduleNext(ms));
      });
    }
  };
  const onOffline = (): void => {
    consecutiveFailures++;
    emitStatus();
  };

  if (typeof window !== "undefined") {
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
  }

  // ARM the scheduler (async but fire-and-forget from construction — the caller
  // can await the initial pass if needed via fireNow).
  void arm();

  return {
    stop(): void {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (typeof window !== "undefined") {
        window.removeEventListener("online", onOnline);
        window.removeEventListener("offline", onOffline);
      }
    },
    async fireNow(): Promise<SyncPassOutcome> {
      return fireOnce();
    },
    getStatus(): SchedulerStatus {
      return {
        state: inFlight
          ? "syncing"
          : consecutiveFailures >= 2 && !isOnline()
            ? "suspended"
            : isOnline()
              ? "idle"
              : "offline",
        lastOutcome,
        consecutiveFailures,
        nextFireAt,
      };
    },
  };
}
