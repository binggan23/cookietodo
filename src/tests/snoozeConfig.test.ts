/**
 * Slice 6 RED tests — snooze-interval config module (ADR 0007 Decision C:
 * snooze bounds are 10 minutes × exactly 3 attempts; the interval is
 * overridable at build time via `VITE_SNOOZE_INTERVAL_MS`).
 *
 * `resolveSnoozeInterval` is a pure parse-don't-validate boundary: a raw env
 * string that is non-empty all-digits is honored, anything else (undefined,
 * empty, non-numeric, negative — no negative here since `-1` fails `/^\d+$/`)
 * falls back to the ADR 0007 default of 10 * 60 * 1000 ms.
 *
 * Tests are RED now: the module does not exist yet.
 */
import { describe, expect, it } from "vitest";

import { MAX_SNOOZES, resolveSnoozeInterval } from "../src/alarm/snoozeConfig";

describe("resolveSnoozeInterval — ADR 0007 Decision C snooze config", () => {
  it("returns the 10-minute default when raw is undefined", () => {
    expect(resolveSnoozeInterval(undefined)).toBe(10 * 60 * 1000);
  });

  it("parses a valid non-empty all-digit string into milliseconds", () => {
    expect(resolveSnoozeInterval("3000")).toBe(3000);
  });

  it("falls back to the default when raw is not a non-empty all-digit string", () => {
    expect(resolveSnoozeInterval("abc")).toBe(10 * 60 * 1000);
    expect(resolveSnoozeInterval("")).toBe(10 * 60 * 1000);
  });

  it("MAX_SNOOZES is exactly 3 per ADR 0007 Decision C", () => {
    expect(MAX_SNOOZES).toBe(3);
  });
});
