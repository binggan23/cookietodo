/**
 * Slice 6 — snooze-interval config (ADR 0007 Decision C: snooze bounds are
 * 10 minutes × exactly 3 attempts).
 *
 * The interval is fixed at 10 minutes per ADR 0007, but the renderer build
 * may override it via the `VITE_SNOOZE_INTERVAL_MS` env var (an all-digit
 * millisecond string). `resolveSnoozeInterval` is the parse-don't-validate
 * boundary: a non-empty all-digit string is honored, anything else falls back
 * to the ADR default. `MAX_SNOOZES` fixes the exactly-3 snooze cap.
 *
 * `import.meta.env` is guarded with optional chaining so module evaluation
 * never throws under Node (Vitest) or any runner without a Vite env object —
 * the access degenerates to `undefined` → default.
 */

/** Default snooze gap between Alarm Event refires per ADR 0007 Decision C. */
const DEFAULT_SNOOZE_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Parse the raw `VITE_SNOOZE_INTERVAL_MS` env string into milliseconds.
 * Returns `Number(raw)` when `raw` is a non-empty all-digit string, else the
 * ADR 0007 default of 10 minutes.
 */
export function resolveSnoozeInterval(raw: string | undefined): number {
  if (raw !== undefined && /^\d+$/.test(raw)) {
    return Number(raw);
  }
  return DEFAULT_SNOOZE_INTERVAL_MS;
}

/** The configured snooze gap, resolved once at module load. */
export const SNOOZE_INTERVAL_MS: number = resolveSnoozeInterval(
  import.meta.env?.VITE_SNOOZE_INTERVAL_MS,
);

/** Exactly 3 snooze attempts per ADR 0007 Decision C. */
export const MAX_SNOOZES = 3;
