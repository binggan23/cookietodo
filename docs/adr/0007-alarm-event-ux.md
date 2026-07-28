# ADR 0007: Alarm Event UX — password-dismiss, snooze bounds, recurrence semantics, dual-fire tolerance

**Date**: 2026-07-28
**Status**: Accepted

## Context

Q9 grilling (2026-07-28) decided four user-experience properties of the Alarm Event surface that ADR 0002 did not reach (there it only fixed reliability level + permission strategy). These are user-facing and irreversible-after-ship (an alarm UX that surprises users in the moment of wake becomes "the bad alarm app" the next day), hence ADR-grade.

## Decision A — Alarm dismiss requires a 6-digit numeric password; snooze is the no-password path

The Alarm Event fullscreen UI presents the user two choices, and only one stops the alarm:

1. **"Sleep a bit"** (a `[睡一会儿]` / `[Snooze]` button) — one tap advances the snooze counter and re-schedules the Alarm Event 10 minutes from now. This is the only no-password path off the present Alarm Event.
2. **Password input** — a 6-digit numeric pad; entering the exact 6 digits set during first-alarm-create flow dismisses the Alarm Event (sends `Reminder.state = cleared`, sets `Todo.completed = true`, sets `Todo.completedAt = now`, per Decision B below). Wrong digits increment a wrong-attempt counter but do not resume the alarm earlier; the alarm stays on, sound keeps playing.

The password is set by the user when they create any alarm-bearing Todo for the first time. The password is stored in the device's native secure credential store (Electron `safeStorage` on Win/Linux, Android `Keystore`); never serialized into the Snapshot per ADR 0001 (it is a per-device UX credential, not user data, and Sync would leak it across devices).

## Decision B — Dismissing the alarm marks the Todo `completed`

When the user enters the correct 6-digit password and dismisses the Alarm Event, the system writes:

- `Reminder.state = 'cleared'` (terminal — see ADR 0006 state machine)
- `Todo.completed = true` and `Todo.completedAt = now`

Separate "I want to stop noise but I haven't done the thing" is **not** offered (Decision B = "B2 only" from Q9 grilling — no `Snooze` button doubles as "later not now" dismiss-and-keep-todo). The reason is that ADR 0007 deliberately makes dismissal a commitment: the alarm's purpose is to drag the user into completion; once the user invests in typing six digits they should be marking done. If the user genuinely has not done the work, they can un-complete the Todo in the app afterward.

## Decision C — Snooze bounds: 10 minutes × 3 attempts

The snooze is **10 minutes** between Alarm Event refires. The snooze counter allows **exactly 3 attempts**. On the 4th `Snooze` tap (or 4th auto-refire), the snooze button becomes **disabled / hidden**; the Alarm Event stays on-screen and audibly ringing until the user either enters the 6-digit password (Decision A path 2) or reboots the device (Decision C-extension below).

Implementation: `snoozedUntil` is advanced 10 minutes from the present `now` on each `Snooze` button tap; a `snoozeCount: number` is carried on the Reminder (3 max). The 4th attempt transitions to "cannot snooze further" state and the UI drops the snooze button.

The `snoozeCount` field carries the cross-device state per ADR 0006 merge rules (Reminder scalar LWW); if a second device fires its own Alarm Event in parallel (accepted per Decision D) it has its own `snoozeCount` — both stay concurrent until one of them dismisses or the user reboots.

## Decision C-extension — Device reboot aborts the Alarm Event; Reminder state stays `fired`, not `cleared`

Only device reboot escapes the "infinite alarm after 3rd snooze escape" path, because forcing the user to co-operate with the Alarm Event forever would brick the device. Rule:

- The Alarm Event on-screen + audio is **device-OS-Lifecycle-tied** — reboot of phone, app kill from system, or hard shut-down of desktop session ends the screen+sound pipe.
- On reboot/restart, the app detects a `Reminder.state === 'fired'` whose `completed` did not follow (i.e. password-dismiss never happened) and surfaces a **banner** in the app: "你跳过了闹钟 — `{todo.title}` 标为继续待办" implying the user did not resolve the task and the user must now either complete it manually or accept it remains open.
- The Reminder state itself transitions from `'fired'` to a worn `fired` (still `fired`; never silently advances to `'cleared'`); a follow-up indicator on the Todo row surfaces "上次的闹钟没被关闭请检查" until the user resolves the Todo.
- The user's next legitimate path to clear the Reminder is the in-Todo action "标记完成" (which now functions as the offline equivalent of password-dismiss), or "再设闹钟" (which starts a fresh Reminder).
- The Store guarantees no silent auto-`cleared` following reboot — protection against "my phone rebooted overnight, my todo auto-marked complete".

## Decision D — Two devicesbothmayring

When the user has the app open and synced on two devices (e.g. Windows + Android, both with the same Todo+Reminder) and `triggerAt` arrives:

- Both devices' OS-level AlarmManager / Electron timer fire independently.
- Both present their own fullscreen Alarm Event; each has its own `snoozeCount` until its local user interaction resolves it.
- Dismissing on one device (`Reminder.state = 'cleared'`, `Todo.completed = true`) propagates via the next Sync pass (ADR 0004): the other device's local Reminder is forced to `cleared` per the ADR 0006 state-machine ("`cleared` is monotonic"); its currently-on-screen Alarm Event will continue until the user dismisses it locally OR the app gets the Sync update and the Sync-update path actively cancels the on-screen Alarm Event UI.
- The cancel-on-Sync-update path is implemented (the app monitors its own Store changes; a `Reminder.state` transition from `fired` to `cleared` due to remote merge emits a "Stop the on-screen Alarm Event" command to the local alarm adapter). If the second device is offline and Syncs later, the second device's Alarm Event has already stopped (the user dismissed locally), or is still ringing, and Sync collapsing states is the local resolution.

## Rationale

- The **6-digit password** is the abusive-snoozers defense — most consumer alarm apps ship a similar "math/dismiss-bar" mode; a 6-digit numeric pad is the smallest-hassle predictable defense that scales down to small screens (Apple Watch, phone in pocket, remote via BT keyboard always-available).
- The **3× × 10 min** snooze cap forces the user to engage with the alarm after at most 30 minutes — ~most adult-sleep-cycle boundaries considered.
- **Reboot escape hatch** is required because "infinite ringing until password" could destroy user ownership of their device; the device-OS-lifecycle escape leaves a visible mark in-app so the user still has to resolve that the alarm was bypassed — closes the "shut alarm by reboot = same as never had alarm" loophole.
- **B2-only dismiss (i.e. dismiss ⇒ complete)** commits the user to the alarm's purpose. A separate "later-noise" snooze-off is intentionally omitted (Todoist, Things 3, Apple Reminders each have variants; v1 chooses the harder-commit variant because the explicit user demand was "强制前台全屏 + 声音 + 关闭按钮" — a button to dismiss must mean something more than "later".
- **Decision D** (accept dual-ring) follows user direction that providing only-one-device-rings implies doing a cloud backend (against ADR 0005) and is out of scope.

## Consequences

- New field `snoozeCount: number` (default 0) on `Reminder`; merge as scalar LWW per ADR 0006.
- New `passwordDismiss: boolean` global app state separate from Store (a per-device UX credential), held in the OS Keychain; never on Snapshot.
- Alarm Event UI implements password input AND snooze button AND post-3-snooze "single button still password" state (the snooze button only disappears after 3 increments, password pad remains).
- The app monitors its own Store for remote `Reminder.state` transitions to clear the in-flight Alarm Event when the other device resolved it first.
- A ban on Todo transit to `completed = true` from alarm dismissal without proper `Reminder.state = cleared` — the password-dismiss behaves atomically.
- Reboot-triggered alarm-was-skipped banner is implemented in-UI; user must explicitly act (complete or re-alarm); Store never silently auto-`cleared` from a reboot event.
- Play Store listing notes the use of `USE_FULL_SCREEN_INTENT` + `FOREGROUND_SERVICE` for the alarm; the App's "core function" rationale (per ADR 0002) is the alarm-class functionality documented in this ADR.

## Out of scope

- Configurable snooze duration or customizable snooze count (v1 fixed at 10 min × 3; v2 if requested).
- Multiple alarm passwords per List / per Todo (single global password for the device/app).
- "Wake the screen on Alarm Event" on Linux-on-X11-session-locked scenarios (carried forward from ADR 0002 — out of scope there too).
- Notification-channel-resident heads-up fallback when the app has been force-stopped and AlarmManager cannot wake it (this is the Android-installed-app reality, not a v1 design gap).
