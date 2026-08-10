/**
 * Slice 6 RED tests — password-dismiss + snooze lifecycle on the in-memory
 * {@link ElectronAlarmStub} (the renderer / Vitest no-shell fallback for the
 * extended {@link AlarmAdapter} surface).
 *
 * Mirrors the slice-5 recorder/subscriber contract:
 *   - `dismissAlarm` / `snoozeAlarm` record the reminderId into the new
 *     `dismissed` / `snoozed` arrays.
 *   - `onAlarmDismissed` / `onAlarmSnoozed` register a wrap-listener callback
 *     and return an unsubscribe that removes exactly that callback.
 *
 * Tests are RED now: the stub does not implement the four methods yet.
 */
import { describe, expect, it } from "vitest";

import { createElectronAlarmStub } from "../src/alarm/electronRendererStub";

/**
 * Fixed ULID — same canonical literal as store.alarm.test.ts (Crockford
 * base32, 26 chars, I/L/O/U excluded).
 */
const VALID_REMINDERID = "01ARZ3V8EPRSWSWXN0V4K0K1TS";

describe("ElectronAlarmStub — dismiss + snooze lifecycle (slice 6)", () => {
  it("dismissAlarm records the reminderId into dismissed", async () => {
    const stub = createElectronAlarmStub();
    await stub.dismissAlarm(VALID_REMINDERID);
    expect(stub.dismissed).toEqual([VALID_REMINDERID]);
  });

  it("snoozeAlarm records the reminderId into snoozed", async () => {
    const stub = createElectronAlarmStub();
    await stub.snoozeAlarm(VALID_REMINDERID);
    expect(stub.snoozed).toEqual([VALID_REMINDERID]);
  });

  it("onAlarmDismissed registers a callback; unsubscribe removes exactly it", () => {
    const stub = createElectronAlarmStub();
    const cb = (): void => {};
    const unsubscribe = stub.onAlarmDismissed(cb);
    expect(stub.dismissedSubscribers).toHaveLength(1);
    unsubscribe();
    expect(stub.dismissedSubscribers).toHaveLength(0);
  });

  it("onAlarmSnoozed registers a callback; unsubscribe removes exactly it", () => {
    const stub = createElectronAlarmStub();
    const cb = (): void => {};
    const unsubscribe = stub.onAlarmSnoozed(cb);
    expect(stub.snoozedSubscribers).toHaveLength(1);
    unsubscribe();
    expect(stub.snoozedSubscribers).toHaveLength(0);
  });
});
