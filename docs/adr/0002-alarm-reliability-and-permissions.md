# ADR 0002: Alarm reliability is "must fire" (Level B) with contextual-lazy permission requests

**Date**: 2026-07-28
**Status**: Accepted

## Context

Two coupled decisions from the 2026-07-28 grilling session:

1. **Reliability threshold** for the Alarm Event — does the app promise "try to fire" or "must fire"?
2. **Permission-request strategy** on Android 14+, where the Alarm Event requires up to three runtime permissions (`SCHEDULE_EXACT_ALARM` / `USE_EXACT_ALARM`, `USE_FULL_SCREEN_INTENT`, `SYSTEM_ALERT_WINDOW`).

These are coupled because Level B ("must fire") is what makes the three permissions non-negotiable, and the request strategy decides when the user is asked.

## Decision A — Reliability: Level B ("must fire")

The app is positioned as an **alarm-class application**, not a "reminder bell". This means:

- **On Android**: scheduling uses `AlarmManager.setExactAndAllowWhileIdle`; firing uses `FOREGROUND_SERVICE_SPECIAL_USE` + `Notification.Builder.setFullScreenIntent(pendingIntent, true)`; an irreducible ~200 lines of Kotlin via a custom Capacitor plugin (the desktop equivalent has no Android equivalent lib).
- **On desktop (Electron)**: `BrowserWindow` with `alwaysOnTop: true`, `fullscreen: true`, `skipTaskbar: true` driven by a Node timer. **Out of scope for v1** is "steal foreground while the screen is locked" — v1's desktop behaviour at lock is: sound fires on schedule, full-screen overlay appears the instant the session unlocks. True lock-screen foreground takeover on Win/Linux requires platform-specific syscalls (`WTSRegisterSessionNotification` on Windows, X11/XLOCK signal handling on Linux), deferred to a later ADR if requested.
- **Out of scope (will not be supported)**: firing while the device is powered off. `BOOT_COMPLETED`补响 is Level C, not B; B's guarantee is per-second accurate only when "device is on, app not force-disabled, user has granted the three alarm permissions." Any failure outside that envelope is a user-decision (revoked permission, battery-opt kill), not an app defect.

### Play Store positioning

The play-store listing and the in-app permission-rationale copy both state **alarm is the core function of this app**. Without this positioning, Google auto-revokes `USE_FULL_SCREEN_INTENT` for non-alarm-core apps since 2025-01-22.

## Decision B — Permission strategy: contextual lazy request

Not "ask for three permissions on first launch"; not "show a settings badge and let the user opt in". Instead:

The user sets a todo with a due time → saves it → the Alarm subsystem registers a scheduled intent → **when the Alarm Event fires**, the Capacitor plugin checks each permission it needs and requests whatever is missing *at that moment*, in the context where the user just expected an alarm to ring.

If any permission is refused, the Alarm Event degrades to best-effort (heads-up notification only, no full-screen takeover) and the dismiss-card explains exactly which permission is missing and links to the OS settings page to grant it. The user's mental model is "I set a 5-minute alarm, it didn't take over the screen, the app is telling me why and where to fix it" — not "the alarm silently failed".

### Why not the alternatives

- **First-launch three-permission request** is rejected by Android 12+ runtime behaviour (the system throttles simultaneous multiple dangerous-permission requests) and converts measurably worse than contextual asks. The user has no context for "why three permissions for a todo app".
- **Settings-badge pre-warning (state-aware opt-in)** is the cleanest Material You pattern, but it asks the user to act on a future alarm they haven't felt yet — contextual lazy has both higher conversion and tighter feedback loop.

### Out of scope

- **Pre-flight check**: the todo editor will display an inline warning chip on a saved reminder if any alarm permission is currently missing, so the user is warned *before* the alarm fires — but no permission dialog is triggered from the editor. The dialog still only fires from the Alarm Event path.

## Consequences

- The Alarm Event path is no longer fire-and-forget: it must implement prompt-and-retry — request missing permission → if granted, fire alarm with full takeover → if denied, fire degraded heads-up + show dismiss-with-reason card + persist "alarm permission refused" as a discrete Store state the UI surfaces in todo detail.
- A custom Capacitor plugin (~200 lines Kotlin) is required; off-the-shelf plugins cover the FGS + exact-alarm scheduling but not `setFullScreenIntent`.
- The plugin owns three distinct entry points: (a) `registerAlarm(todo)` called when a reminder is saved, (b) `onAlarmFired` invoked by the pending intent → checks permissions → fires the Alarm Event, (c) `requestPermission(kind)` called by (b) when needed.
- The Store gains a new piece of state at the Reminder granularity: `permissionRefusedAt?: number` (epoch ms) — a denied permission is sticky so subsequent alarms for the same todo do not silently re-prompt the user every 5 minutes.
- The todo editor surfaces a per-reminder chip reflecting current permission state (three-state: ok / partially-missing / refused). The chip's tap action navigates to system settings, *not* to a permission dialog.
- Play Store submission requires a reviewer-facing demo video showing an Alarm Event firing in full-screen takeover mode and the rationale copy explaining alarm-as-core-function.
- Out of scope but reserved: a future "true lock-screen foreground" path on desktop (Win `WTSRegisterSessionNotification`, Linux X11/XLOCK) — if v1 lock-screen sound-only is judged insufficient, ADR 0003 will specify it.
