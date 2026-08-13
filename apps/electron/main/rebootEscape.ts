/**
 * Reboot-escape banner trigger wiring for the Electron main process
 * (Issue #7 AC #7-#8, ADR 0007 "Reboot escape").
 *
 * Why this exists: when an alarm (`state === 'fired'`) is interrupted by a
 * reboot (caller never sees `dismissed` / `snoozed`), the renderer never
 * gets a chance to flag the Reminder. The next launch reads a snapshot in
 * which that Reminder is still `fired` (or, in the past-due-but-pending
 * edge case, the scheduler never got to fire it before shutdown) and the
 * associated Todo is still un-completed — i.e. the user silently got rid
 * of an alarm by powering off the machine (exactly the regressor this
 * whole slice repairs).
 *
 * Surface: `registerRebootEscape(snapshotPath)` — called once from
 * {@link apps/electron/main/index.ts} during main-process setup. It binds
 * Electron's `will-quit` and `session-end` events to a synchronous rewrite
 * of `snapshot.json` that adds `pendingPostRebootBanner: true` to every
 * escaped Reminder.
 *
 * Drift guard: the canonical pure matcher lives in
 * `src/src/persistence/markRebootEscapes.ts` (Vitest-tested, no Electron /
 * `fs` import). The renderer package does NOT ship a runtime JS bundle (see
 * {@link apps/electron/main/snapshotSchema.ts} for the same drift-guard
 * pattern), so the matcher logic is mirrored here under the same
 * lockstep discipline — when the canvas matcher changes there, mirror the
 * change here and update the paired test `src/tests/markRebootEscapes.test.ts`.
 *
 * Write path is atomic per ADR 0003 (write-tmp + fsync + rename) — same
 * pattern as {@link apps/electron/main/ElectronStoreAdapter}: a partial
 * write on power-loss must NOT replace the on-disk file with a malformed
 * snapshot, so the only OS-level rename-time visible is the full file.
 *
 * Synchronous fs deliberately: these hooks fire on shutdown, and Electron's
 * `will-quit` does NOT wait for promises — async I/O here would race
 * `app.exit`. The disk write must complete before the process tears down.
 */
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";

import { app } from "electron";

import { type Snapshot, SnapshotSchema } from "./snapshotSchema.js";

const TMP_SUFFIX = ".tmp";

/**
 * Register the reboot-escape banner trigger against the snapshot file at
 * `snapshotPath`. Safe to call multiple times — the trigger function is
 * idempotent at the data level (re-flagging an already-flagged Reminder is a
 * no-op fast path), so a duplicate listener does not corrupt state.
 *
 * `snapshotPath` MUST be a stable path for the lifetime of the process —
 * the caller in {@link apps/electron/main/index.ts} derives it from
 * `app.getPath('userData') + '/snapshot.json'` once at startup.
 */
export function registerRebootEscape(snapshotPath: string): void {
  const trigger = (): void => {
    try {
      markRebootEscapesToFile(snapshotPath, Date.now());
    } catch (err) {
      // ADR 0008: surface, swallow — the trigger is best-effort. A failure
      // here only means the next launch will not show the banner for those
      // Reminders (the underlying data is untouched); the alternative is
      // blocking app shutdown and quitting the user off their machine.
      console.warn("[rebootEscape] failed to flag escaped Reminders before quit:", err);
    }
  };

  // `before-quit` is the earliest shutdown signal Electron fires (before any
  // window closes). It is the right hook for a synchronous fs rewrite —
  // `will-quit` (after window teardown) is added as a second-chance trigger
  // for the rare path where `before-quit`'s listener was installed mid-shutdown
  // (rare and hard to repro, but the cost is one idempotent extra call).
  // `session-end` is NOT a real Electron `app` event; it is a Windows-only OS
  // session signal that Node never surfaces here. We rely on `before-quit`
  // (covers Cmd-Q, Alt-F4, system shutdown, reboot) — the only omitted path
  // is a SIGKILL of the main process, which leaves no time for I/O anyway.
  app.on("before-quit", trigger);
  app.on("will-quit", trigger);
}

/**
 * Read -> pure transform -> write `snapshotPath` atomically.
 *
 * Exported (rather than inlined into `registerRebootEscape`) so the
 * synchronous fs rewrite can be exercised directly by integration tests
 * without depending on Electron's runtime events.
 *
 * Throws if `snapshotPath` is missing (ENOENT — no snapshot to flag,
 * nothing to do here; caller swallows, the next launch handles first-launch
 * semantics via ElectronStoreAdapter.loadSnapshot). Throws on JSON parse /
 * Zod validation failure too — the caller's catch logs and continues; we do
 * not silently rewrite a corrupt file.
 */
export function markRebootEscapesToFile(snapshotPath: string, now: number): void {
  let raw: string;
  try {
    raw = readFileSync(snapshotPath, "utf8");
  } catch {
    // No snapshot file yet (first launch) — nothing to flag.
    return;
  }
  const parsedRaw: unknown = JSON.parse(raw);
  const snapshot: Snapshot = SnapshotSchema.parse(parsedRaw);

  const next = applyMarkRebootEscapes(snapshot, now);

  // No-op fast path: nothing got flagged, do NOT rewrite the on-disk file
  // (avoids a needless tmp+rename dance on every clean shutdown).
  if (next === snapshot) {
    return;
  }

  const json = JSON.stringify(next, null, 2);
  const tmp = `${snapshotPath}${TMP_SUFFIX}`;

  // Mirrors ElectronStoreAdapter.saveSnapshot's atomic pattern — synchronous
  // variants because we are inside will-quit and get ONE chance to write.
  let fd: number | null = null;
  try {
    fd = openSync(tmp, "w");
    writeSync(fd, json);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    // POSIX rename(2) atomic on same fs; Win32 transparent via Node.
    renameSync(tmp, snapshotPath);
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // best-effort close on the error path
      }
    }
    // Best-effort cleanup of the tmp file (ignore ENOENT — maybe rename
    // succeeded then a later step threw, maybe open failed and tmp does not
    // exist). Surface the underlying error to the caller.
    try {
      unlinkSync(tmp);
    } catch {
      // ignore — best-effort
    }
    throw err;
  }
}

/**
 * Drift-guard mirror of `src/src/persistence/markRebootEscapes.ts`'s
 * `markRebootEscapes`. Returns a new Snapshot with
 * `pendingPostRebootBanner: true` set on every Reminder that escaped via
 * reboot (state `fired`, OR state `pending` AND `triggerAt <= now`) AND whose
 * Todo is still un-completed. Terminal reminders (`cleared` / `cancelled`)
 * are left untouched. Idempotent: an already-flagged Reminder leaves its
 * object reference unchanged and the snapshot is returned as-is.
 *
 * CRITICAL INVARIANT: never advances `state`, never mutates `triggerAt` /
 * `snoozedUntil` / `snoozeCount`, never completes a Todo.
 */
function applyMarkRebootEscapes(snapshot: Snapshot, now: number): Snapshot {
  const uncompletedTodoIds = new Set<string>();
  for (const todo of snapshot.todos) {
    if (!todo.completed) {
      uncompletedTodoIds.add(todo.id);
    }
  }

  let mutated = false;
  const nextReminders: Snapshot["reminders"] = [];
  for (const reminder of snapshot.reminders) {
    if (
      uncompletedTodoIds.has(reminder.todoId) &&
      reminder.pendingPostRebootBanner === false &&
      escapedViaReboot(reminder, now)
    ) {
      nextReminders.push({
        ...reminder,
        pendingPostRebootBanner: true,
      });
      mutated = true;
    } else {
      nextReminders.push(reminder);
    }
  }

  if (!mutated) {
    return snapshot;
  }

  return {
    ...snapshot,
    reminders: nextReminders,
  };
}

function escapedViaReboot(reminder: Snapshot["reminders"][number], now: number): boolean {
  if (reminder.state === "fired") return true;
  if (reminder.state === "pending" && reminder.triggerAt <= now) return true;
  return false;
}
