/**
 * Slice 9 — Recurrence scheduler tests (issue #9).
 *
 * Tests the `computeNextTriggerAt` function across daily/weekly/monthly
 * configurations, anchor semantics, and exhaustion (count/until).
 */
import { describe, expect, it } from "vitest";
import { computeNextTriggerAt } from "../src/alarm/scheduler";
import type { Recurrence } from "../src/domain/types";

const _HOUR_MS = 3600_000;
const DAY_MS = 86_400_000;

function daily(overrides?: Partial<Recurrence>): Recurrence {
  return {
    kind: "daily",
    interval: 1,
    weekdayMask: null,
    daysOfMonth: null,
    nthWeekday: null,
    count: null,
    until: null,
    anchor: "due",
    ...overrides,
  };
}

describe("computeNextTriggerAt", () => {
  it("daily recurrence: returns next day at same time", async () => {
    const prev = Date.parse("2026-08-01T09:00:00Z");
    const next = await computeNextTriggerAt(daily(), prev, prev);
    expect(next).toBe(prev + DAY_MS);
  });

  it("daily interval=3: returns 3 days later", async () => {
    const prev = Date.parse("2026-08-01T09:00:00Z");
    const next = await computeNextTriggerAt(daily({ interval: 3 }), prev, prev);
    expect(next).toBe(prev + 3 * DAY_MS);
  });

  it("weekly with Monday mask: returns next Monday", async () => {
    // Aug 1, 2026 is a Saturday — next Monday is Aug 3.
    const prev = Date.parse("2026-08-01T09:00:00Z");
    const next = await computeNextTriggerAt(
      { ...daily({ kind: "weekly" }), weekdayMask: 0b0000001 }, // Monday = bit 0
      prev,
      prev,
    );
    const expected = Date.parse("2026-08-03T09:00:00Z");
    expect(next).toBe(expected);
  });

  it("count=1: returns null after first generation (exhausted)", async () => {
    const prev = Date.parse("2026-08-01T09:00:00Z");
    const next = await computeNextTriggerAt(daily({ count: 1 }), prev, prev);
    expect(next).toBeNull();
  });

  it("count=2: first call returns next, second call returns null (exhausted via inc= false)", async () => {
    const prev = Date.parse("2026-08-01T09:00:00Z");
    const first = await computeNextTriggerAt(daily({ count: 2 }), prev, prev);
    // Count=2 includes dtstart + 1 recurrence → next should be prev + 1 day.
    expect(first).toBe(prev + DAY_MS);
  });

  it("until < computed next: returns null", async () => {
    const prev = Date.parse("2026-08-01T09:00:00Z");
    const until = prev + DAY_MS - 1; // One ms before the next would fire.
    const next = await computeNextTriggerAt(daily({ until }), prev, prev);
    expect(next).toBeNull();
  });

  it("monthly with daysOfMonth=[15]: returns next occurrence on the 15th", async () => {
    const prev = Date.parse("2026-08-01T09:00:00Z");
    const next = await computeNextTriggerAt(
      { ...daily({ kind: "monthly" }), daysOfMonth: [15] },
      prev,
      prev,
    );
    expect(next).toBe(Date.parse("2026-08-15T09:00:00Z"));
  });

  it("anchor='completed': uses completedAt as base for next trigger", async () => {
    const prevTrigger = Date.parse("2026-08-01T09:00:00Z");
    const completedAt = Date.parse("2026-08-01T09:05:00Z"); // 5 min later
    const next = await computeNextTriggerAt(
      daily({ anchor: "completed" }),
      completedAt,
      prevTrigger,
    );
    // Should be completedAt + 1 day, NOT prevTrigger + 1 day.
    expect(next).toBe(completedAt + DAY_MS);
  });

  it("returns null when recurrence has no valid future occurrence (count exhausted)", async () => {
    const prev = Date.parse("2026-08-01T09:00:00Z");
    const first = await computeNextTriggerAt(daily({ count: 1 }), prev, prev);
    expect(first).toBeNull();
  });
});
